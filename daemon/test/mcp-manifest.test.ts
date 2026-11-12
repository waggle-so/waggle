import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventBus } from "../src/events";
import type { RpcServer } from "../src/server";
import { startRpcServer } from "../src/server";
import { Store } from "../src/store";
import { MCP_TOOLS } from "../src/protocol";
import type { McpManifestTool } from "../src/protocol";
import { rmrf, rpcConnect, tmpHome } from "./helpers";
import pkg from "../package.json" with { type: "json" };

// Daemon versions for these tests follow the client's own version: a daemon
// older than the client is refused ("background service is older"), so fixed
// strings like "0.1.8" broke the moment the package version moved past them.
const V_A = pkg.version;
const V_B = (() => {
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();

// HAIL-48: the daemon serves the MCP tool surface live over `mcp.manifest`,
// and the shim (`waggle mcp`) relays it - listing tools from whatever it last
// fetched, forwarding every call unvalidated (the daemon is the only
// validator). On a reconnect where the daemon's version changed, the shim
// re-fetches the manifest and sends notifications/tools/list_changed so an
// already-open session picks up new tools without a restart.

interface Shim {
  client: Client;
  transport: StdioClientTransport;
}

interface ContentItem {
  type: string;
  text?: string;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
  if (!("content" in result)) return "";
  return (result.content as ContentItem[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
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

function setup(): { home: string; cwd: string; store: Store; socketPath: string } {
  const home = tmpHome();
  homes.push(home);
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const socketPath = join(home, "knock.sock");
  const db = new Database(join(home, "knock.db"));
  const bus = new EventBus();
  const store = new Store(db, home, bus);
  return { home, cwd, store, socketPath };
}

function startDaemon(
  opts: { socketPath: string; store: Store },
  overrides: { version: string; mcpManifestTools?: McpManifestTool[]; mcpManifestEnabled?: boolean } = {
    version: V_A,
  },
): RpcServer {
  const bus = new EventBus();
  const server = startRpcServer({
    socketPath: opts.socketPath,
    store: opts.store,
    bus,
    ...overrides,
  });
  servers.push(server);
  return server;
}

async function startShim(home: string, sessionId: string, cwd: string): Promise<Shim> {
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: { KNOCK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId },
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "knock-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const shim = { client, transport };
  shims.push(shim);
  return shim;
}

describe("mcp.manifest (socket RPC)", () => {
  test("returns the daemon version and every tool's name, description and JSON input schema", async () => {
    const { store, socketPath } = setup();
    startDaemon({ socketPath, store }, { version: "9.9.9" });

    const client = await rpcConnect(socketPath);
    const res = await client.request("mcp.manifest", {});
    client.close();

    const result = res.result as { daemon_version: string; tools: McpManifestTool[] };
    expect(result.daemon_version).toBe("9.9.9");
    // HAIL-176: the six waggle_* tools, plus the six old knock_* aliases while the switch is on.
    expect(result.tools.map((t) => t.name).sort()).toEqual(
      [
        "knock_ask", "knock_check", "knock_guide", "knock_settings", "knock_themes", "knock_update",
        "waggle_ask", "waggle_check", "waggle_guide", "waggle_settings", "waggle_themes", "waggle_update",
      ].sort(),
    );
    const ask = result.tools.find((t) => t.name === "waggle_ask")!;
    expect(ask.description).toContain("Ask the human a blocking question or review");
    expect(ask.inputSchema).toMatchObject({ type: "object", required: expect.any(Array) });
  });
});

describe("open input schemas (HAIL-48 amendment A1)", () => {
  test("every tool's advertised schema accepts fields it does not name", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(true);
    }
  });

  test("the daemon ignores a field it does not recognize instead of rejecting the call", async () => {
    const { store, socketPath } = setup();
    startDaemon({ socketPath, store });

    const client = await rpcConnect(socketPath);
    await client.request("session.hello", {
      session_id: "sess-a",
      cwd: "/tmp/work",
      parent_pid: process.pid,
    });
    const res = await client.request("case.create", {
      kind: "question",
      title: "Compact or detailed?",
      need: "Pick a layout.",
      why: "Design call.",
      recommendation: "Compact",
      recommendation_why: "Fits more on screen.",
      // A field no released schema has ever defined - stands in for a future
      // release's field an already-open session's client still lets through
      // because the schema it cached is open (see toolInputSchema).
      a_future_field_not_yet_invented: "some value",
    });
    client.close();

    expect(res.error).toBeUndefined();
    expect((res.result as { id: string }).id).toBeTruthy();
  });
});

describe("tool annotations", () => {
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

  test("every tool, alias included, sets all four hints to a boolean", () => {
    for (const tool of MCP_TOOLS) {
      for (const hint of HINTS) expect(typeof tool.annotations?.[hint]).toBe("boolean");
    }
  });

  test("each tool's hints match what its handler does", () => {
    const of = (name: string) => MCP_TOOLS.find((t) => t.name === name)?.annotations;
    expect(of("waggle_ask")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(of("waggle_update")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    for (const name of ["waggle_check", "waggle_guide"]) {
      expect(of(name)).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    for (const name of ["waggle_settings", "waggle_themes"]) {
      expect(of(name)).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
  });

  test("tools/list relays the hints, and lists a tool without them when an old daemon sends none", async () => {
    const { home, cwd, store, socketPath } = setup();
    const oldTools: McpManifestTool[] = MCP_TOOLS.map(({ annotations: _, ...t }) => t);
    startDaemon({ socketPath, store }, { version: V_B, mcpManifestTools: oldTools });
    const { client } = await startShim(home, "sess-a", cwd);
    const listed = await client.listTools();
    expect(listed.tools.find((t) => t.name === "waggle_ask")?.annotations).toBeUndefined();
  });

  test("tools/list relays the hints of the live manifest", async () => {
    const { home, cwd, store, socketPath } = setup();
    startDaemon({ socketPath, store }, { version: V_B });
    const { client } = await startShim(home, "sess-a", cwd);
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const expected = MCP_TOOLS.find((t) => t.name === tool.name)!.annotations;
      expect(tool.annotations).toEqual(expected);
    }
  });
});

describe("guide.get (socket RPC)", () => {
  test("returns the topic index with no topic, and one guide's text with a topic", async () => {
    const { store, socketPath } = setup();
    startDaemon({ socketPath, store });

    const client = await rpcConnect(socketPath);
    const index = await client.request("guide.get", {});
    expect((index.result as { text: string }).text).toContain("writing-an-ask");

    const topic = await client.request("guide.get", { topic: "artifacts" });
    expect((topic.result as { text: string }).text).toContain("html_bundle");
    client.close();
  });

  test("an unknown topic fails with the same message getGuide has always thrown", async () => {
    const { store, socketPath } = setup();
    startDaemon({ socketPath, store });

    const client = await rpcConnect(socketPath);
    const res = await client.request("guide.get", { topic: "nope" });
    client.close();

    expect(res.error).toBeDefined();
    expect((res.error as { data?: { message?: string } }).data?.message).toContain(
      'Unknown guide topic "nope"',
    );
  });
});

describe("waggle mcp: live tool manifest (HAIL-48)", () => {
  test("tools/list reflects the daemon's live manifest, not just the shim's compiled-in one", async () => {
    const { home, cwd, store, socketPath } = setup();
    const v2Tools: McpManifestTool[] = MCP_TOOLS.map((t) =>
      t.name === "waggle_ask" ? { ...t, description: "TEST MARKER: v2 waggle_ask description" } : t,
    );
    startDaemon({ socketPath, store }, { version: V_B, mcpManifestTools: v2Tools });

    const { client } = await startShim(home, "sess-a", cwd);
    const tools = await client.listTools();
    const ask = tools.tools.find((t) => t.name === "waggle_ask");
    expect(ask?.description).toBe("TEST MARKER: v2 waggle_ask description");
  });

  test("falls back to the shim's own compiled-in manifest when the daemon has no mcp.manifest", async () => {
    const { home, cwd, store, socketPath } = setup();
    startDaemon({ socketPath, store }, { version: V_A, mcpManifestEnabled: false });

    const { client } = await startShim(home, "sess-a", cwd);
    // A call that needs the daemon still works (session.hello and case.create
    // do not depend on mcp.manifest); only the tool listing falls back.
    const result = await client.callTool({
      name: "waggle_guide",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    const ask = tools.tools.find((t) => t.name === "waggle_ask");
    expect(ask?.description).toBe(MCP_TOOLS.find((t) => t.name === "waggle_ask")!.description);
  });

  test(
    "on a reconnect where the daemon version changed, the shim sends tools/list_changed and then lists the new manifest",
    async () => {
      const { home, cwd, store, socketPath } = setup();
      const daemonA = startDaemon({ socketPath, store }, { version: V_A, mcpManifestTools: MCP_TOOLS });

      const { client } = await startShim(home, "sess-a", cwd);

      let notified: (() => void) | null = null;
      const notification = new Promise<void>((resolve) => {
        notified = resolve;
      });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        notified?.();
      });

      // Establishes the shim's baseline manifest/version against daemon A.
      const first = await client.listTools();
      expect(first.tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());

      // Swap daemon A for daemon B on the same socket path: a new tool and a
      // newer version, standing in for an app-triggered daemon restart after
      // an update (docs/SERVICE.md).
      const v2Tools: McpManifestTool[] = [
        ...MCP_TOOLS,
        { name: "knock_extra", description: "A v2-only tool.", inputSchema: { type: "object" } },
      ];
      daemonA.stop(); // closes the shim's live connection to daemon A
      startDaemon({ socketPath, store }, { version: V_B, mcpManifestTools: v2Tools });

      // Any call forces the shim to notice the dead connection and reconnect
      // (KNOCK-18): this is what re-fetches the manifest and, since the
      // version changed, sends the notification.
      const second = await client.callTool({ name: "waggle_guide", arguments: {} });
      expect(second.isError).toBeFalsy();

      await notification;

      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(
        v2Tools.map((t) => t.name).sort(),
      );
      expect(listed.tools.find((t) => t.name === "knock_extra")?.description).toBe(
        "A v2-only tool.",
      );
    },
    15000,
  );

  test(
    "the next tool result after a version change carries a one-line update notice, once (amendment A1)",
    async () => {
      const { home, cwd, store, socketPath } = setup();
      const daemonA = startDaemon({ socketPath, store }, { version: V_A, mcpManifestTools: MCP_TOOLS });

      const { client } = await startShim(home, "sess-a", cwd);
      await client.listTools(); // establishes the shim's baseline version against daemon A

      daemonA.stop();
      startDaemon({ socketPath, store }, { version: V_B, mcpManifestTools: MCP_TOOLS });

      // notifications/tools/list_changed alone does not reach an
      // already-open Claude Code or Codex session (docs/protocol-mvp.md), so
      // the call that discovers the reconnect carries the notice on its own
      // result - the shim has no earlier result left to attach it to.
      const first = await client.callTool({ name: "waggle_guide", arguments: {} });
      expect(textOf(first)).toContain(
        `Waggle was updated to ${V_B}. Call waggle_guide with topic "whats-new" for what changed.`,
      );

      // A second call on the same connection, no further version change:
      // the notice already fired once and is gone.
      const second = await client.callTool({ name: "waggle_guide", arguments: {} });
      expect(textOf(second)).not.toContain("Waggle was updated to");
    },
    15000,
  );
});
