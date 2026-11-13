import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AskCheck, HOLD_WINDOW_MS } from "../src/ask-check";
import { EventBus } from "../src/events";
import { HELD_NEXT } from "../src/mcp/shim";
import { startRpcServer, type RpcServer } from "../src/server";
import { Store } from "../src/store";
import { UsageLogger } from "../src/usage";
import type { KnockAskInput } from "../src/protocol";
import { rmrf, rpcConnect, stageIncoming, tmpHome, type RpcClient } from "./helpers";

// WAG-416: the check inside waggle_ask. A decision that fits past decisions of its project is held once.

const homes: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      // Already closed.
    }
  }
  for (const home of homes.splice(0)) rmrf(home);
});

const cacheAsk: KnockAskInput = {
  title: "Which cache backend for sessions?",
  need: "Pick the cache for user sessions.",
  why: "Two fit.",
  recommendation: "a",
  recommendation_why: "It is simpler.",
  options: [
    { id: "a", label: "Use Redis", title: "Redis" },
    { id: "b", label: "Use SQLite", title: "SQLite" },
  ],
};
// A new ask on the question that cacheAsk decided before: other words, so it is not the same open ask.
const sameAsk: KnockAskInput = { ...cacheAsk, title: "Which cache backend should sessions use?", need: "We need a cache for the sessions." };

let server: RpcServer;
async function boot() {
  const home = tmpHome();
  homes.push(home);
  const db = new Database(join(home, "knock.db"));
  const usage = new UsageLogger(db, home);
  const store = new Store(db, home, new EventBus(), usage);
  server = startRpcServer({ socketPath: join(home, "knock.sock"), store, bus: new EventBus(), version: "0.1.0", onRestart: () => {} });
  closers.push(() => server.stop(), () => db.close());
  const work = join(home, "work", "waggle");
  mkdirSync(work, { recursive: true });
  const client: RpcClient = await rpcConnect(join(home, "knock.sock"));
  closers.push(() => client.close());
  const hello = (await client.request("session.hello", { session_id: "sess-1", cwd: work, parent_pid: 4242 })).result as { task_id: string };
  const ask = (input: Record<string, unknown>, requestId: string, hold = true) =>
    client.request("case.create", { ...input, client_request_id: requestId, ...(hold ? { accepts_hold: true } : {}) });
  // An earlier decided ask in the same project.
  const earlier = store.createCase(hello.task_id, cacheAsk);
  store.submitReply(earlier.id, { idempotency_key: "k-early", choice: "b", message: "No new service.", comments: [], captures: [] });
  return { home, db, store, client, ask, earlier, work };
}

const usageRows = (db: Database, event: string) => db.query(`SELECT * FROM usage WHERE event = ?`).all(event) as Record<string, unknown>[];
type Held = { held: true; matches: { case_id: string; question: string; pick: string; why: string; date: string }[] };

describe("hold, then pass on the second send", () => {
  test("the first send is held with the matches and creates no case; the second creates it with the ids", async () => {
    const { ask, store, db, earlier } = await boot();
    const first = await ask(sameAsk, "req-first-0001");
    expect(first.error).toBeUndefined();
    const held = first.result as Held;
    expect(held.held).toBe(true);
    expect(held.matches).toHaveLength(1);
    expect(held.matches[0]).toMatchObject({ case_id: earlier.id, pick: "Use SQLite", why: "No new service." });
    // No case yet: only the earlier one exists.
    expect(store.listCases().filter((c) => c.id !== earlier.id)).toHaveLength(0);
    // The usage log holds a code and a count, no text.
    const rows = usageRows(db, "ask_held");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n: 1 });
    expect(JSON.stringify(rows)).not.toContain("cache");

    const second = await ask(sameAsk, "req-second-002");
    const created = second.result as { id: string; matched_case_ids: string[] };
    expect(created.matched_case_ids).toEqual([earlier.id]);
    expect(store.caseById(created.id)?.matched_case_ids).toEqual([earlier.id]);
    // The case payload to the app carries the ids (cases.get reads the stored column).
    expect(created.matched_case_ids).toEqual([earlier.id]);
  });

  test("a retry of the held call (same request id) gets the hold again, not a case", async () => {
    const { ask, store, earlier } = await boot();
    await ask(sameAsk, "req-retry-0001");
    const again = await ask(sameAsk, "req-retry-0001");
    expect(again.error).toBeUndefined();
    expect((again.result as Held).held).toBe(true);
    expect(store.listCases().filter((c) => c.id !== earlier.id)).toHaveLength(0);
  });

  test("a better ask that names the old decision passes when it fits only decisions already shown", async () => {
    const { ask, earlier } = await boot();
    await ask(sameAsk, "req-better-0001");
    const better = await ask({ ...sameAsk, title: "Which cache backend for sessions, given the SQLite decision?", need: `Case ${earlier.id} chose SQLite. Does it still hold?` }, "req-better-0002");
    expect((better.result as { id: string }).id).toBeString();
    expect((better.result as { matched_case_ids: string[] }).matched_case_ids).toEqual([earlier.id]);
  });
});

describe("what is never held", () => {
  test("no match: the ask is created at once", async () => {
    const { ask } = await boot();
    const res = await ask({ ...cacheAsk, title: "Rename the settings page", need: "A new name." }, "req-nomatch-001");
    expect((res.result as { id: string }).id).toBeString();
    expect((res.result as { matched_case_ids: string[] }).matched_case_ids).toEqual([]);
  });

  test("a review is not held", async () => {
    const { ask, home, work } = await boot();
    writeFileSync(join(work, "plan.md"), "# Plan\n");
    const res = await ask(
      {
        kind: "review",
        title: sameAsk.title,
        need: sameAsk.need,
        why: "It ships tomorrow.",
        recommendation: "approve",
        recommendation_why: "It reads well.",
        artifact: stageIncoming(home, work, { type: "markdown", path: "plan.md" }),
      },
      "req-review-0001",
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { held?: boolean }).held).toBeUndefined();
    expect((res.result as { kind: string }).kind).toBe("review");
  });

  test("an ask with follows or replaces is not held", async () => {
    const { ask, earlier } = await boot();
    const follows = await ask({ ...sameAsk, follows: earlier.id }, "req-follow-0001");
    expect((follows.result as { id?: string }).id).toBeString();
    const replaces = await ask({ ...sameAsk, title: "Which cache backend for sessions? Again", replaces: (follows.result as { id: string }).id }, "req-replace-001");
    expect((replaces.result as { id?: string }).id).toBeString();
  });

  test("a shim that does not say accepts_hold is never held", async () => {
    const { ask } = await boot();
    const res = await ask(sameAsk, "req-old-shim-001", false);
    expect((res.result as { id?: string }).id).toBeString();
  });

  test("another project's decision does not hold the ask", async () => {
    const { client, home, ask } = await boot();
    const other = join(home, "work", "other-project");
    mkdirSync(other, { recursive: true });
    const second = await rpcConnect(join(home, "knock.sock"));
    closers.push(() => second.close());
    await second.request("session.hello", { session_id: "sess-2", cwd: other, parent_pid: 4243 });
    const res = await second.request("case.create", { ...sameAsk, client_request_id: "req-other-0001", accepts_hold: true });
    expect((res.result as { id?: string }).id).toBeString();
    void client;
    void ask;
  });

  test("the Ask less rules still decide an ask that goes through", async () => {
    const { ask, store } = await boot();
    store.setAskLess({ enabled: true, rules: { naming: true, wording: false, formatting: false, tests: false } });
    const res = await ask({ ...sameAsk, category: "naming" }, "req-less-000001");
    const created = res.result as { id: string; status: string; auto_decided?: { choice: string } };
    expect(created.held).toBeUndefined();
    expect(created.status).toBe("resolved");
    expect(created.auto_decided?.choice).toBe("a");
  });
});

describe("a failed search lets the ask through", () => {
  test("the ask is created and the usage log gets a coded event", async () => {
    const { ask, db, store } = await boot();
    db.exec("DROP TABLE decided_asks");
    const res = await ask(sameAsk, "req-fail-000001");
    expect(res.error).toBeUndefined();
    expect((res.result as { id?: string }).id).toBeString();
    expect(usageRows(db, "ask_check_failed")).toHaveLength(1);
    void store;
  });
});

describe("AskCheck window", () => {
  const match = { case_id: "c_old", question: "q", pick: "p", why: "w", date: "d" };
  test("a hold older than the window is forgotten, so the ask is held again", () => {
    let now = 1_000_000;
    const check = new AskCheck(() => now);
    const run = () => check.run({ sessionId: "s", title: "Same title", search: () => [match] });
    expect(run().action).toBe("hold");
    now += HOLD_WINDOW_MS + 1;
    expect(run().action).toBe("hold");
  });
  test("inside the window the same title passes; another session is held", () => {
    const now = 1_000_000;
    const check = new AskCheck(() => now);
    const run = (s: string, t = "Same title") => check.run({ sessionId: s, title: t, search: () => [match] });
    expect(run("s").action).toBe("hold");
    expect(run("s", "  same   TITLE ")).toEqual({ action: "pass", matchedCaseIds: ["c_old"] });
    expect(run("other").action).toBe("hold");
  });
  test("a search that throws passes", () => {
    let failed = 0;
    const check = new AskCheck();
    const result = check.run({ sessionId: "s", title: "t", search: () => { throw new Error("boom"); }, onFailed: () => failed++ });
    expect(result).toEqual({ action: "pass", matchedCaseIds: [] });
    expect(failed).toBe(1);
  });
  test("the reply text names the three ways out", () => {
    expect(HELD_NEXT).toContain("Drop the ask");
    expect(HELD_NEXT).toContain("better ask");
    expect(HELD_NEXT).toContain("same ask again");
  });
});
