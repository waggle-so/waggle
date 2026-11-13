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
import { caseErrorFor } from "../src/mcp/errors";
import { DaemonRpcError } from "../src/mcp/client";
import { DAEMON_UNREACHABLE_ERROR } from "../src/protocol";
import pkg from "../package.json" with { type: "json" };
import { rmrf, tmpHome } from "./helpers";

// WAG-268: an ask that is open while the shim restarts, or while the client cancels the call (what
// Claude Code does around /compact), survives it. Real `waggle mcp` over stdio, in-process daemon.

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

describe("an open ask survives a restart or a cancel (WAG-268)", () => {
  test("a cancelled waggle_ask does not eat the reply: waggle_check on the same session gets it", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-cancel", cwd, { KNOCK_ASK_WAIT_MS: "20000" });
    const controller = new AbortController();
    const asked = client.callTool({ name: "waggle_ask", arguments: question }, undefined, { signal: controller.signal });
    asked.catch(() => {});
    await waitFor(() => store.listCases().length === 1);
    const caseId = store.listCases()[0].id;
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await expect(asked).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 300));

    store.createReply(caseId, { idempotency_key: "k-cancel", choice: "a", message: "Go with A.", comments: [], captures: [] });
    const checked = await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(textOf(checked)).toContain("Choice: a (Compact)");
    expect(store.getCase(caseId)!.replies[0].state).toBe("delivered");
  }, 20000);

  test("a reply that came while the first call was cancelled is not marked delivered by it", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-cancel-2", cwd, { KNOCK_ASK_WAIT_MS: "20000" });
    const controller = new AbortController();
    const asked = client.callTool({ name: "waggle_ask", arguments: question }, undefined, { signal: controller.signal });
    asked.catch(() => {});
    await waitFor(() => store.listCases().length === 1);
    const caseId = store.listCases()[0].id;
    controller.abort();
    await new Promise((r) => setTimeout(r, 300));
    store.createReply(caseId, { idempotency_key: "k-cancel-2", choice: "b", message: "B.", comments: [], captures: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(store.getCase(caseId)!.replies[0].state).toBe("queued");
    const checked = await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(textOf(checked)).toContain("Choice: b (Detailed)");
  }, 20000);

  test("after a shim restart with a new session, waggle_check gets the reply sent while it was gone", async () => {
    const { home, cwd, store } = setup();
    const first = await startShim(home, "sess-old", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const pending = await first.client.callTool({ name: "waggle_ask", arguments: question });
    const caseId = extractCaseId(textOf(pending));
    await first.client.close();
    await waitFor(() => (store.db.query(`SELECT state FROM sessions WHERE id = ?`).get("sess-old") as { state: string }).state === "disconnected");

    store.createReply(caseId, { idempotency_key: "k-restart", choice: "a", message: "Go with A.", comments: [], captures: [] });
    // Only a short gap: the app still sees a live session.
    expect(store.getCase(caseId)!.case.session_state).toBe("live");

    const second = await startShim(home, "sess-new", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const checked = await second.client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(checked.isError).toBeFalsy();
    expect(textOf(checked)).toContain("Choice: a (Compact)");
    expect(store.getCase(caseId)!.replies[0].state).toBe("delivered");
  }, 20000);

  test("a reply that failed because the old session ended is delivered to the new session", async () => {
    const { home, cwd, store } = setup();
    const first = await startShim(home, "sess-old-2", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await first.client.callTool({ name: "waggle_ask", arguments: question })));
    await first.client.close();
    store.createReply(caseId, { idempotency_key: "k-ended", choice: "b", message: "B.", comments: [], captures: [] });
    store.setSessionState("sess-old-2", "ended");
    expect(store.getCase(caseId)!.replies[0].state).toBe("failed");

    const second = await startShim(home, "sess-new-2", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const checked = await second.client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(textOf(checked)).toContain("Choice: b (Detailed)");
    expect(store.getCase(caseId)!.replies[0].state).toBe("delivered");
  }, 20000);

  test("the same ask again from the new session reattaches: no second case", async () => {
    const { home, cwd, store } = setup();
    const first = await startShim(home, "sess-old-3", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await first.client.callTool({ name: "waggle_ask", arguments: question })));
    await first.client.close();

    const second = await startShim(home, "sess-new-3", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const again = await second.client.callTool({ name: "waggle_ask", arguments: question });
    expect(again.isError).toBeFalsy();
    expect(extractCaseId(textOf(again))).toBe(caseId);
    expect(store.listCases()).toHaveLength(1);

    // And a third time, from the same shim: still one case.
    const third = await second.client.callTool({ name: "waggle_ask", arguments: question });
    expect(extractCaseId(textOf(third))).toBe(caseId);
    expect(store.listCases()).toHaveLength(1);
  }, 20000);

  test("the same ask again after the human answered it is a new ask", async () => {
    const { home, cwd, store } = setup();
    const { client } = await startShim(home, "sess-again", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await client.callTool({ name: "waggle_ask", arguments: question })));
    store.createReply(caseId, { idempotency_key: "k-again", choice: "a", message: "A.", comments: [], captures: [] });
    await client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    const next = await client.callTool({ name: "waggle_ask", arguments: question });
    expect(extractCaseId(textOf(next))).not.toBe(caseId);
    expect(store.listCases()).toHaveLength(2);
  }, 20000);

  test("a session from another folder cannot take the case, and the error says what to do", async () => {
    const { home, cwd, store } = setup();
    const first = await startShim(home, "sess-old-4", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await first.client.callTool({ name: "waggle_ask", arguments: question })));
    await first.client.close();
    const other = join(home, "other");
    mkdirSync(other, { recursive: true });
    const second = await startShim(home, "sess-other", other, { KNOCK_ASK_WAIT_MS: "300" });
    const checked = await second.client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(checked.isError).toBe(true);
    expect(textOf(checked)).toContain("belongs to another coding session or folder");
    expect(textOf(checked)).toContain("waggle_ask");
  }, 20000);

  test("a live session of the same folder cannot take the case", async () => {
    const { home, cwd } = setup();
    const a = await startShim(home, "sess-live-a", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await a.client.callTool({ name: "waggle_ask", arguments: question })));
    const b = await startShim(home, "sess-live-b", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const checked = await b.client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(checked.isError).toBe(true);
  }, 20000);

  test("a session that has been gone longer than the grace shows as disconnected", async () => {
    const { home, cwd, store } = setup();
    const first = await startShim(home, "sess-grace", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await first.client.callTool({ name: "waggle_ask", arguments: question })));
    await first.client.close();
    await waitFor(() => (store.db.query(`SELECT state FROM sessions WHERE id = ?`).get("sess-grace") as { state: string }).state === "disconnected");
    store.db.exec(`UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = 'sess-grace'`);
    expect(store.getCase(caseId)!.case.session_state).toBe("disconnected");
  }, 20000);
});

describe("caseErrorFor", () => {
  test("a lost connection names the open case and the next step", () => {
    const text = caseErrorFor(new Error(DAEMON_UNREACHABLE_ERROR), "c_abc").message;
    expect(text).toContain("The connection to Waggle restarted. Your ask c_abc is still open.");
    expect(text).toContain("call waggle_check with case_id c_abc");
    expect(text).not.toMatch(/socket|stack|ECONN|timed out/i);
  });

  test("a timeout reads the same way", () => {
    const text = caseErrorFor(new Error("timed out waiting for the waggle daemon"), "c_abc").message;
    expect(text).toContain("Your ask c_abc is still open.");
  });

  test("ownership and missing-case errors say what to do", () => {
    expect(caseErrorFor(new DaemonRpcError(-32001, "not your case"), "c_x").message).toContain("waggle_ask");
    expect(caseErrorFor(new DaemonRpcError(-32002, "case not found"), "c_x").message).toContain("Check the id");
  });

  test("any other error passes through", () => {
    const err = new Error("something else");
    expect(caseErrorFor(err, "c_x")).toBe(err);
  });
});

describe("an old open ask is not taken over after a long time (WAG-268)", () => {
  test("the same ask from a new session, long after the old one was last seen, is a new case", async () => {
    const { home, cwd, store } = setup();
    const first = await startShim(home, "sess-stale", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const caseId = extractCaseId(textOf(await first.client.callTool({ name: "waggle_ask", arguments: question })));
    await first.client.close();
    await waitFor(() => (store.db.query(`SELECT state FROM sessions WHERE id = ?`).get("sess-stale") as { state: string }).state === "disconnected");
    store.db.exec(`UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = 'sess-stale'`);
    const second = await startShim(home, "sess-fresh", cwd, { KNOCK_ASK_WAIT_MS: "300" });
    const again = await second.client.callTool({ name: "waggle_ask", arguments: question });
    expect(extractCaseId(textOf(again))).not.toBe(caseId);
    // An explicit waggle_check with the id still works.
    const checked = await second.client.callTool({ name: "waggle_check", arguments: { case_id: caseId } });
    expect(checked.isError).toBeFalsy();
  }, 20000);
});
