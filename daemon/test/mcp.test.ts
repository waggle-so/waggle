import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventBus } from "../src/events";
import type { RpcServer } from "../src/server";
import { startRpcServer } from "../src/server";
import { Store } from "../src/store";
import { RUNTIME_NOTES, instructionsFor } from "../src/protocol";
import { DEFAULT_ASK_PREFERENCES, askAgentText } from "../src/guide/asks";
import pkg from "../package.json" with { type: "json" };
import { rmrf, tmpHome } from "./helpers";

// Drives the real `waggle mcp` binary over stdio with the MCP SDK client, against
// an in-process RPC server on a temp KNOCK_HOME (KNOCK-04 verification). The
// in-process store lets the test seed replies directly.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_PNG = Buffer.concat([PNG_SIG, Buffer.from("annotated png")]).toString("base64");

const question = {
  kind: "question",
  title: "Pick a layout",
  need: "Pick a layout",
  why: "I cannot decide",
  recommendation: "a",
  recommendation_why: "It is the default",
  options: [
    { id: "a", label: "Compact" },
    { id: "b", label: "Detailed" },
  ],
};

interface Shim {
  client: Client;
  transport: StdioClientTransport;
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

const homes: string[] = [];
const servers: RpcServer[] = [];
const shims: Shim[] = [];

afterEach(async () => {
  for (const shim of shims.splice(0)) {
    try {
      await shim.transport.close();
    } catch {
      // Already closed.
    }
    try {
      await shim.client.close();
    } catch {
      // Already closed.
    }
  }
  for (const server of servers.splice(0)) {
    try {
      server.stop();
    } catch {
      // Already stopped.
    }
  }
  for (const home of homes.splice(0)) {
    rmrf(home);
  }
});

function setup(): { home: string; cwd: string; store: Store } {
  const home = tmpHome();
  homes.push(home);
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const db = new Database(join(home, "knock.db"));
  const bus = new EventBus();
  const store = new Store(db, home, bus);
  const server = startRpcServer({
    socketPath: join(home, "knock.sock"),
    store,
    bus,
    // Match the shim's own version (pkg.version), or the HAIL-27 version
    // handshake would refuse the shim's hello as "daemon older than client".
    version: pkg.version,
  });
  servers.push(server);
  return { home, cwd, store };
}

async function startShim(
  home: string,
  sessionId: string,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ client: Client }> {
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: { KNOCK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId, ...env },
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "knock-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  shims.push({ client, transport });
  return { client };
}

// The SDK's callTool result is a union: one member carries `content`, the other
// carries `toolResult` for task-based tools. Narrow on `content` before reading.
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
  if (!("content" in result)) return "";
  return (result.content as ContentItem[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function extractCaseId(text: string): string {
  const match = text.match(/case_id":"(c_[^"]+)"/);
  if (!match) throw new Error(`no case id in pending text: ${text}`);
  return match[1];
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met in time");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("waggle mcp", () => {
  test("initialize serves the agent instructions, plus the claude runtime note by default (HAIL-30, HAIL-38)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd);

    // HAIL-101: with a reachable daemon the operator's ask preferences ride on the end.
    expect(client.getInstructions()).toBe(instructionsFor("claude", askAgentText(DEFAULT_ASK_PREFERENCES)));
    expect(client.getInstructions()).toContain("product, design, or UX options");
    expect(client.getInstructions()).toContain("write the title as the question itself");
    expect(client.getInstructions()).toContain(RUNTIME_NOTES.claude);
  });

  test("initialize carries the operator's saved ask preferences (HAIL-101)", async () => {
    const { home, cwd, store } = setup();
    store.setAskTopics({ scope: "pick", picked: ["design", "code"] });
    store.setAskFrequency("blocked");
    store.setAskDetail("rich");
    const { client } = await startShim(home, "sess-prefs", cwd);

    const text = client.getInstructions() ?? "";
    expect(text).toContain("## Operator preferences · asks");
    expect(text).toContain("only when you are blocked on me: design and UX; code and architecture.");
    expect(text).toContain("Make each ask rich");
    expect(text.endsWith(askAgentText(store.getAskPreferences()))).toBe(true);
  });

  test("initialize serves the codex runtime note for a codex session (HAIL-38)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-codex", cwd, { KNOCK_RUNTIME: "codex" });

    expect(client.getInstructions()).toBe(instructionsFor("codex", askAgentText(DEFAULT_ASK_PREFERENCES)));
    expect(client.getInstructions()).toContain(RUNTIME_NOTES.codex);
    expect(client.getInstructions()).not.toContain(RUNTIME_NOTES.claude);
  });

  test("waggle_ask creates a case and returns pending with its case_id on timeout", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const result = await client.callTool({ name: "waggle_ask", arguments: question });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    const caseId = extractCaseId(text);
    expect(text).toContain("Call waggle_check with this case_id");

    const listed = store.listCases("needs_you");
    expect(listed.map((c) => c.id)).toContain(caseId);
  });

  // HAIL-176: the old knock_* names are aliases of the waggle_* tools, served by the same handlers.
  test("the knock_* aliases are listed with the old-name description and run the same handlers", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const tools = (await client.listTools()).tools;
    for (const name of ["ask", "check", "update", "guide", "settings"]) {
      const alias = tools.find((t) => t.name === `knock_${name}`);
      expect(alias?.description).toBe(`Old name of waggle_${name}. Use waggle_${name}.`);
      expect(alias?.inputSchema).toEqual(tools.find((t) => t.name === `waggle_${name}`)?.inputSchema);
    }

    const asked = await client.callTool({ name: "knock_ask", arguments: question });
    expect(asked.isError).toBeFalsy();
    const caseId = extractCaseId(textOf(asked));
    expect(store.listCases("needs_you").map((c) => c.id)).toContain(caseId);

    const checked = await client.callTool({ name: "knock_check", arguments: { case_id: caseId } });
    expect(checked.isError).toBeFalsy();
    expect(textOf(checked)).toContain(caseId);

    expect(textOf(await client.callTool({ name: "knock_guide", arguments: {} }))).toBe(
      textOf(await client.callTool({ name: "waggle_guide", arguments: {} })),
    );
  });

  test("waggle_ask prepends the ASD-STE100 warning line when the ask breaks a limit (HAIL-140)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const need = Array(21).fill("word").join(" ");
    const result = await client.callTool({ name: "waggle_ask", arguments: { ...question, need } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Waggle: this ask breaks ASD-STE100 limits (need sentence over 20 words).");
    expect(text).toContain("Call waggle_check with this case_id");
    // The ask is still created, never rejected.
    expect(store.listCases("needs_you").length).toBeGreaterThan(0);
  });

  test("waggle_ask adds no warning in normal mode (HAIL-140)", async () => {
    const { home, cwd, store } = setup();
    store.setAskWords("normal");
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const need = Array(21).fill("word").join(" ");
    const result = await client.callTool({ name: "waggle_ask", arguments: { ...question, need } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toContain("ASD-STE100 limits");
    expect(text).toContain("Call waggle_check with this case_id");
  });

  test("waggle_check returns the reply payload and the ack marks it delivered", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const pending = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));

    store.createReply(caseId, {
      idempotency_key: "key-1",
      choice: "a",
      message: "Go with A.",
      comments: [
        {
          id: "cmt-1",
          capture_id: "cap-1",
          n: 1,
          rect: { x: 0.12, y: 0.31, w: 0.76, h: 0.06 },
          text: "Default this to Monthly.",
        },
      ],
      captures: [
        {
          id: "cap-1",
          revision: 1,
          png_base64: FAKE_PNG,
          annotated_png_base64: FAKE_PNG,
          taken_at: "2026-09-26T00:00:00.000Z",
        },
      ],
    });

    const result = await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(result.isError).toBeFalsy();
    const content = result.content as ContentItem[];
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[0].text).toContain('Reply to "Pick a layout"');
    expect(content[0].text).toContain("Choice: a (Compact)");
    expect(content[0].text).toContain("Message: Go with A.");
    expect(content[0].text).toContain(
      "[1] (region x=0.12 y=0.31 w=0.76 h=0.06) Default this to Monthly.",
    );
    expect(content[1]).toMatchObject({ type: "image", data: FAKE_PNG, mimeType: "image/png" });

    const detail = store.getCase(caseId)!;
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0].state).toBe("delivered");
  });

  test("a session cannot check another session's case", async () => {
    const { home, cwd } = setup();
    const a = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const b = await startShim(home, "sess-b", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const pending = await a.client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));

    const result = await b.client.callTool({
      name: "waggle_check",
      arguments: { case_id: caseId },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("belongs to another coding session or folder");
  });

  test("waggle_ask returns the reply when it arrives during the wait", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "5000" });

    const askPromise = client.callTool({ name: "waggle_ask", arguments: question });
    await waitFor(() => store.listCases().length === 1);
    const caseId = store.listCases()[0].id;
    store.createReply(caseId, {
      idempotency_key: "key-1",
      choice: "a",
      message: "Go with A.",
      comments: [],
      captures: [],
    });

    const result = await askPromise;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('Reply to "Pick a layout"');
    expect(text).toContain("Choice: a (Compact)");
    expect(text).toContain("Message: Go with A.");
  });

  // HAIL-44: waggle_ask's replaces prepends a note when the human had already
  // answered the withdrawn ask (a reply still queued - no agent ever called
  // waggle_check/waggle_ask to pick it up), so that answer is never lost.
  test("waggle_ask with replaces prepends the withdrawn ask's already-answered note", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const first = await client.callTool({ name: "waggle_ask", arguments: question });
    const earlierId = extractCaseId(textOf(first));
    store.createReply(earlierId, { idempotency_key: "key-1", choice: "a", comments: [], captures: [] });

    const second = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, title: "Pick a layout (clearer)", replaces: earlierId },
    });
    expect(second.isError).toBeFalsy();
    const text = textOf(second);
    expect(text).toContain("Note: the human answered the ask you replaced: a (Compact). Take it into account.");
    expect(text).toContain("Call waggle_check with this case_id");

    expect(store.getCase(earlierId)!.case.status).toBe("resolved");
    expect(store.getCase(earlierId)!.case.withdrawn_at).not.toBeNull();
    expect(store.getCase(earlierId)!.replies[0].state).toBe("delivered");
  });

  test("waggle_ask with replaces adds no note when the withdrawn ask had no queued reply", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const first = await client.callTool({ name: "waggle_ask", arguments: question });
    const earlierId = extractCaseId(textOf(first));

    const second = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, replaces: earlierId },
    });
    expect(textOf(second)).not.toContain("already answered");
  });

  test("waggle_update adds a message and moves the case back to needs_you", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const pending = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));

    store.createReply(caseId, { idempotency_key: "key-1", comments: [], captures: [] });
    expect(store.getCase(caseId)!.case.status).toBe("waiting_on_agent");

    const result = await client.callTool({
      name: "waggle_update",
      arguments: { case_id: caseId, message: "I added more detail." },
    });
    expect(result.isError).toBeFalsy();

    const detail = store.getCase(caseId)!;
    expect(detail.case.status).toBe("needs_you");
    expect(detail.messages.some((m) => m.role === "agent" && m.text === "I added more detail.")).toBe(
      true,
    );
  });

  // HAIL-152: a done update closes the case and tells the agent not to wait.
  test("waggle_update with done closes the case and says no answer will come (HAIL-152)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const pending = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));
    store.createReply(caseId, { idempotency_key: "key-1", comments: [], captures: [] });

    const result = await client.callTool({
      name: "waggle_update",
      arguments: { case_id: caseId, message: "Done and live.", done: true },
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("closed as done");
    expect(text).toContain("no answer will come");
    expect(text).toContain("do not call waggle_check");
    expect(store.getCase(caseId)!.case.status).toBe("waiting_on_agent");
    expect(store.getCase(caseId)!.case.done_at).not.toBeNull();

    const withOptions = await client.callTool({
      name: "waggle_update",
      arguments: {
        case_id: caseId,
        message: "x",
        done: true,
        options: [{ id: "x", label: "X" }],
        recommendation: "x",
      },
    });
    expect(withOptions.isError).toBe(true);
  });

  // HAIL-146: a message or new options without an artifact, on a case that has one, adds a line.
  test("waggle_update without an artifact on a case with one reminds the agent (HAIL-146)", async () => {
    const { home, cwd, store } = setup();
    mkdirSync(join(cwd, "shots"), { recursive: true });
    writeFileSync(join(cwd, "shots", "a.png"), Buffer.concat([PNG_SIG, Buffer.from("shot")]));
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const pending = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, kind: "review", artifact: { type: "screenshot", path: "./shots/a.png" } },
    });
    const caseId = extractCaseId(textOf(pending));

    const messageOnly = await client.callTool({
      name: "waggle_update",
      arguments: { case_id: caseId, message: "Rewrote the last beat." },
    });
    expect(messageOnly.isError).toBeFalsy();
    expect(textOf(messageOnly)).toContain("The old artifact stays on screen.");

    const withOptions = await client.callTool({
      name: "waggle_update",
      arguments: {
        case_id: caseId,
        message: "New sentences.",
        options: [{ id: "x", title: "One", label: "First sentence" }],
        recommendation: "x",
      },
    });
    expect(textOf(withOptions)).toContain("The old artifact stays on screen.");

    const withArtifact = await client.callTool({
      name: "waggle_update",
      arguments: { case_id: caseId, message: "New shot.", artifact: { type: "screenshot", path: "./shots/a.png" } },
    });
    expect(textOf(withArtifact)).not.toContain("old artifact");
    expect(store.getCase(caseId)!.case.status).toBe("needs_you");
  });

  test("waggle_update on a case without an artifact adds no reminder (HAIL-146)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const pending = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));
    const result = await client.callTool({
      name: "waggle_update",
      arguments: { case_id: caseId, message: "More detail." },
    });
    expect(textOf(result)).not.toContain("old artifact");
  });

  // HAIL-108 round trip: waggle_update carries a new option set, the human picks
  // from it, and the reply the agent gets names the new title.
  test("waggle_update with options, then a reply choosing a new option id (HAIL-108)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const pending = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));
    store.submitReply(caseId, { idempotency_key: "d1", message: "why?", intent: "more_detail", comments: [], captures: [] });
    await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });

    const newOptions = [
      { id: "x", title: "Two steps", label: "Ship the schema first, then the UI" },
      { id: "y", title: "One step", label: "Ship both together" },
    ];
    const update = await client.callTool({
      name: "waggle_update",
      arguments: {
        case_id: caseId,
        message: "Here is a better split.",
        options: newOptions,
        recommendation: "x",
        recommendation_why: "Smaller review.",
      },
    });
    expect(update.isError).toBeFalsy();
    const c = store.getCase(caseId)!.case;
    expect(c.options).toEqual(newOptions);
    expect(c.first_options.map((o) => o.id)).toEqual(["a", "b"]);

    const bad = await client.callTool({
      name: "waggle_update",
      arguments: { case_id: caseId, message: "oops", options: newOptions, recommendation: "nope" },
    });
    expect(bad.isError).toBe(true);

    store.submitReply(caseId, { idempotency_key: "k2", choice: "x", comments: [], captures: [] });
    const reply = await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(textOf(reply)).toContain("Choice: x (Ship the schema first, then the UI)");
  });

  test("waggle_check carries the attached files as text, so the shim needs no change (WAG-345)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-attach", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const result = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(result));
    mkdirSync(join(home, "incoming", "u1"), { recursive: true });
    writeFileSync(join(home, "incoming", "u1", "notes.md"), "# notes");
    const reply = store.submitReply(caseId, {
      idempotency_key: "att1",
      intent: "discuss",
      comments: [],
      captures: [],
      attachments: [{ name: "notes.md", incoming_path: join(home, "incoming", "u1", "notes.md") }],
    });
    const checked = textOf(await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } }));
    expect(checked).toContain("Attached: 1 file");
    expect(checked).toContain(`- notes.md: ${join(home, "attachments", reply.id, "notes.md")}`);
  });

  test("waggle_ask with a screenshot stages it as revision 1", async () => {
    const { home, cwd, store } = setup();
    mkdirSync(join(cwd, "shots"), { recursive: true });
    writeFileSync(join(cwd, "shots", "a.png"), Buffer.concat([PNG_SIG, Buffer.from("shot")]));
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const result = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, kind: "review", artifact: { type: "screenshot", path: "./shots/a.png" } },
    });
    const caseId = extractCaseId(textOf(result));

    const detail = store.getCase(caseId)!;
    expect(detail.case.has_artifact).toBe(true);
    expect(detail.revisions.map((r) => r.n)).toEqual([1]);
  });

  test("waggle_ask denormalizes the runtime from KNOCK_RUNTIME onto the case (KNOCK-20)", async () => {
    const { home, cwd, store } = setup();

    const claudeShim = await startShim(home, "sess-claude", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const claudePending = await claudeShim.client.callTool({ name: "waggle_ask", arguments: question });
    const claudeCaseId = extractCaseId(textOf(claudePending));
    expect(store.getCase(claudeCaseId)!.case.runtime).toBe("claude");

    const codexShim = await startShim(home, "sess-codex", cwd, {
      KNOCK_ASK_WAIT_MS: "300",
      KNOCK_RUNTIME: "codex",
    });
    const codexPending = await codexShim.client.callTool({ name: "waggle_ask", arguments: question });
    const codexCaseId = extractCaseId(textOf(codexPending));
    expect(store.getCase(codexCaseId)!.case.runtime).toBe("codex");
  });

  test("waggle_ask names the project from the git root the shim reports (HAIL-26)", async () => {
    const { home, store } = setup();
    const repo = join(home, "omea-web");
    mkdirSync(join(repo, "app"), { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    const projectCwd = join(repo, "app");

    const { client } = await startShim(home, "sess-git", projectCwd, { KNOCK_ASK_WAIT_MS: "300" });
    const result = await client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(result));

    expect(store.getCase(caseId)!.case.project).toBe("omea-web");
  });

  test("a validation failure names the missing field and creates no case", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const result = await client.callTool({
      name: "waggle_ask",
      arguments: { kind: "question", title: "Pick a layout" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/need|why|recommendation/);
    expect(store.listCases()).toHaveLength(0);
  });

  // HAIL-48: the shim no longer Zod-validates locally, so an unrecognized
  // artifact.type must not silently mis-stage as an html_bundle (its old
  // implicit "everything else" branch, safe only because Zod used to reject
  // an unknown type before staging ever ran) - it passes through unstaged
  // and the daemon's own schema names the real problem.
  test("an unrecognized artifact type is rejected by the daemon, not mis-staged as html_bundle", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const result = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, kind: "review", artifact: { type: "bogus", path: "./shots/a.png" } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("dir");
    expect(textOf(result)).not.toContain("entry");
    expect(store.listCases()).toHaveLength(0);
  });

  test("tools/list carries field guidance for waggle_ask (HAIL-37)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd);

    const tools = await client.listTools();
    const ask = tools.tools.find((t) => t.name === "waggle_ask");
    expect(ask).toBeDefined();
    const props = (ask!.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties!;
    expect(props.why?.description).toBe(
      "1 to 3 sentences: why you cannot decide this yourself. Put longer reasoning, data or a plan " +
        "in an artifact (markdown for reasoning, html_bundle for visuals, comparisons or plans). " +
        "Max 500 characters.",
    );
    expect(props.need?.description).toBe(
      "The decision you need, in one or two sentences. The queue shows its first line.",
    );
    expect(props.recommendation_why?.description).toBe("1 to 2 sentences.");
    expect(props.artifact?.description).toBe(
      "Attach whenever the operator must read more than a few sentences or see something: markdown " +
        "for a write-up, html_bundle for a prototype, chart, table or plan, screenshot for one image, " +
        "screenshots for 2 to 12 images the operator flips through and comments on one at a time " +
        "(with several decisions, give each image `item`, the id of its decision, so a decision shows only its images), " +
        "diagram for a flow or structure with more than 3 parts (a .mmd Mermaid file or a .svg). " +
        "For html_bundle, give the case pane a real preview with the artifact's preview field: a " +
        "small purpose-built summary of the decision, never a screenshot of the page.",
    );
  });

  test("why over 500 characters is rejected with a retryable error and no case is created (HAIL-37)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const okResult = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, why: "a".repeat(500) },
    });
    expect(okResult.isError).toBeFalsy();
    expect(store.listCases()).toHaveLength(1);

    const tooLong = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, why: "a".repeat(501) },
    });
    expect(tooLong.isError).toBe(true);
    expect(textOf(tooLong)).toContain(
      "why is 501 characters; the maximum is 500. Keep why to 1 to 3 sentences and put the details " +
        "in an artifact: markdown for reasoning, html_bundle for a prototype, chart or plan.",
    );
    expect(store.listCases()).toHaveLength(1);
  });

  test("why over 500 characters is counted after trimming (HAIL-37)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const padded = `  ${"a".repeat(500)}  `;
    const result = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, why: padded },
    });
    expect(result.isError).toBeFalsy();
    expect(store.listCases()).toHaveLength(1);
  });

  test("recommendation_why over 300 characters is rejected with a retryable error (HAIL-37)", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });

    const okResult = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, recommendation_why: "a".repeat(300) },
    });
    expect(okResult.isError).toBeFalsy();
    expect(store.listCases()).toHaveLength(1);

    const tooLong = await client.callTool({
      name: "waggle_ask",
      arguments: { ...question, recommendation_why: "a".repeat(301) },
    });
    expect(tooLong.isError).toBe(true);
    expect(textOf(tooLong)).toContain(
      "recommendation_why is 301 characters; the maximum is 300. Keep recommendation_why to 1 to 3 " +
        "sentences and put the details in an artifact: markdown for reasoning, html_bundle for a " +
        "prototype, chart or plan.",
    );
    expect(store.listCases()).toHaveLength(1);
  });

  test("waggle_guide with no arguments lists every topic (HAIL-38)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd);

    const result = await client.callTool({ name: "waggle_guide", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    for (const topic of ["writing-an-ask", "artifacts", "reviews", "after-the-reply"]) {
      expect(text).toContain(topic);
    }
  });

  test("waggle_guide with a topic loads that guide (HAIL-38)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd);

    const result = await client.callTool({ name: "waggle_guide", arguments: { topic: "artifacts" } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("# Choosing and building an artifact");
    expect(text).toContain("html_bundle");
  });

  test("waggle_guide adds the design kit when the project has one (SYL-2)", async () => {
    const { home, cwd } = setup();
    mkdirSync(join(cwd, ".knock"), { recursive: true });
    writeFileSync(join(cwd, ".knock", "design-kit.md"), "## Pen file\ndesign/system.pen\n");
    const { client } = await startShim(home, "sess-kit", cwd);

    const artifacts = textOf(await client.callTool({ name: "waggle_guide", arguments: { topic: "artifacts" } }));
    expect(artifacts).toContain("## This project's design kit");
    expect(artifacts).toContain("design/system.pen");
    expect(textOf(await client.callTool({ name: "waggle_guide", arguments: {} }))).toContain(".knock/design-kit.md");
    // Other topics stay as they are.
    const reviews = textOf(await client.callTool({ name: "waggle_guide", arguments: { topic: "reviews" } }));
    expect(reviews).not.toContain("design kit");
  });

  test("waggle_guide is unchanged when the project has no design kit (SYL-2)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-nokit", cwd);

    const artifacts = textOf(await client.callTool({ name: "waggle_guide", arguments: { topic: "artifacts" } }));
    expect(artifacts).not.toContain("## This project's design kit");
    expect(textOf(await client.callTool({ name: "waggle_guide", arguments: {} }))).not.toContain("has a design kit");
  });

  test("artifacts guide has the decision pages section, offline only (HAIL-98)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd);

    const result = await client.callTool({ name: "waggle_guide", arguments: { topic: "artifacts" } });
    const text = textOf(result);
    const start = text.indexOf("## Decision pages");
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start + 3);
    const end = rest.search(/\n## /);
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section).toContain("Patterns adapted from visualize by careerhackeralex (MIT).");
    expect(section).not.toMatch(/<script/i);
    expect(section).not.toMatch(/<link/i);
    expect(section).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(section).not.toContain("http");
  });

  test("waggle_guide with an unknown topic lists the valid topics (HAIL-38)", async () => {
    const { home, cwd } = setup();
    const { client } = await startShim(home, "sess-a", cwd);

    const result = await client.callTool({ name: "waggle_guide", arguments: { topic: "nope" } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Unknown guide topic "nope"');
    for (const topic of ["writing-an-ask", "artifacts", "reviews", "after-the-reply"]) {
      expect(text).toContain(topic);
    }
  });
});
