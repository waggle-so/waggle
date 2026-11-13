import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { EventBus } from "../src/events";
import { getGuide, guideTopics } from "../src/guide";
import { projectGuide } from "../src/guide/project";
import { CORRECTION_TRIGGER_COUNT, GUIDE_CORRECTION_COUNT } from "../src/projects";
import { buildMcpTools, KNOCK_ASK_DESCRIPTION } from "../src/protocol/mcp";
import type { KnockAskInput } from "../src/protocol";
import { startRpcServer, type RpcServer } from "../src/server";
import { Store } from "../src/store";
import { rmrf, rpcConnect, tmpHome } from "./helpers";
import pkg from "../package.json" with { type: "json" };

// WAG-260: the project page. Decision log, themes, the repo-record switch, the project guide topic.

function ask(title: string, extra: Partial<KnockAskInput> = {}): KnockAskInput {
  return {
    kind: "question",
    title,
    need: title,
    why: "Needed",
    recommendation: "a",
    recommendation_why: "It is the default",
    options: [
      { id: "a", label: "Compact layout", title: "Compact" },
      { id: "b", label: "Detailed layout", title: "Detailed" },
    ],
    ...extra,
  } as KnockAskInput;
}

function setup(project = "waggle") {
  const store = new Store(new Database(":memory:"), "/tmp/knock-test", new EventBus());
  const task = store.createTask({ name: "work", project });
  store.createSession(task.id, { id: "sess-1", cwd: "/work", branch: null, pid: 4242 });
  return { store, task };
}

let n = 0;
function decide(store: Store, caseId: string, input: { choice?: string; message?: string; intent?: "decision" | "more_detail" }) {
  return store.submitReply(caseId, {
    idempotency_key: `k${n++}`,
    choice: input.choice,
    message: input.message,
    intent: input.intent ?? "decision",
    comments: [],
    captures: [],
  } as never);
}

describe("decision log", () => {
  test("counts decided asks only, newest first, with why fallback", () => {
    const { store, task } = setup();
    const c1 = store.createCase(task.id, ask("First?")).id;
    const c2 = store.createCase(task.id, ask("Second?")).id;
    const c3 = store.createCase(task.id, ask("Undecided?")).id;
    const c4 = store.createCase(task.id, ask("Detail only?")).id;
    decide(store, c1, { choice: "b", message: "Operator note" });
    decide(store, c2, { choice: "a" });
    decide(store, c4, { intent: "more_detail", message: "Tell me more" });
    void c3;
    const { items, total } = store.projects.decisions("waggle");
    expect(total).toBe(2);
    expect(items.map((i) => i.question)).toEqual(["Second?", "First?"]);
    expect(items[0]).toMatchObject({ pick: "Compact", why: "It is the default", option_count: 2, artifact_kind: null });
    expect(items[1]).toMatchObject({ pick: "Detailed", why: "Operator note" });
  });

  test("a dismissed ask and another project do not count; paging works", () => {
    const { store, task } = setup();
    const other = store.createTask({ name: "x", project: "other" });
    const a = store.createCase(task.id, ask("A?")).id;
    const b = store.createCase(task.id, ask("B?")).id;
    const o = store.createCase(other.id, ask("O?")).id;
    decide(store, a, { choice: "a" });
    decide(store, b, { choice: "a" });
    decide(store, o, { choice: "a" });
    store.dismissCase(b);
    expect(store.projects.decisions("waggle").total).toBe(1);
    expect(store.projects.decisions("other").total).toBe(1);
    const c = store.createCase(task.id, ask("C?")).id;
    decide(store, c, { choice: "a" });
    expect(store.projects.decisions("waggle", 1, 1).items).toHaveLength(1);
    expect(store.projects.stats("waggle").decisions).toBe(2);
  });

  test("stats count notes as comments", () => {
    const { store, task } = setup();
    const a = store.createCase(task.id, ask("A?")).id;
    decide(store, a, { choice: "a", message: "Plain words please" });
    const s = store.projects.stats("waggle");
    expect(s.comments).toBe(1);
    expect(s.last_decision_at).not.toBeNull();
  });
});

describe("themes", () => {
  test("merge by case-insensitive exact or prefix, no duplicates, off stays off", () => {
    const { store } = setup();
    const p = store.projects;
    const r1 = p.propose("waggle", "sess-1", [
      { text: "Plain words, never code", evidence_count: 3, quotes: ["no code please"] },
      { text: "Pointer cursor", evidence_count: 1, quotes: [] },
    ]);
    expect(r1.added).toHaveLength(2);
    const theme = r1.added[0]!;
    p.setThemeEnabled(theme.id, false);
    const r2 = p.propose("waggle", "sess-2", [
      { text: "plain words", evidence_count: 5, quotes: ["no code please", "say it plain", "a", "b"] },
    ]);
    expect(r2.added).toHaveLength(0);
    expect(r2.merged).toHaveLength(1);
    const all = p.themes("waggle");
    expect(all).toHaveLength(2);
    expect(all[0]!.enabled).toBe(false);
    expect(all[0]!.evidence_count).toBe(5);
    expect(all[0]!.quotes).toEqual(["no code please", "say it plain", "a"]);
    expect(all[0]!.proposed_by).toBe("sess-1");
  });

  test("themes are per project", () => {
    const { store } = setup();
    store.projects.propose("a", null, [{ text: "T", evidence_count: 1, quotes: [] }]);
    expect(store.projects.themes("b")).toHaveLength(0);
  });
});

describe("project guide topic", () => {
  const base = { project: "waggle", decisions: [], themes: [], repoRecords: false, stale: false, comments: [] };
  const themes = [
    { id: "1", scope: "project" as const, case_ids: [] as string[], text: "Plain words", evidence_count: 2, quotes: [], enabled: true, proposed_by: null, created_at: "", updated_at: "" },
    { id: "2", scope: "project" as const, case_ids: [] as string[], text: "Dark chrome", evidence_count: 2, quotes: [], enabled: false, proposed_by: null, created_at: "", updated_at: "" },
  ];

  test("is listed and the ask description points at it", () => {
    expect(guideTopics()).toContain("project");
    expect(getGuide("project")).toBeTruthy();
    expect(KNOCK_ASK_DESCRIPTION + buildMcpTools().map((t) => t.description).join("")).toContain("topic project");
  });

  test("fresh: only ON themes, no comments, no propose instruction", () => {
    const text = projectGuide({ ...base, themes, comments: ["x"] });
    expect(text).toContain("Plain words");
    expect(text).not.toContain("Dark chrome");
    expect(text).not.toContain("waggle_themes");
  });

  test("stale: comments and the propose instruction", () => {
    const text = projectGuide({ ...base, stale: true, comments: ["Use plain words", "No code"] });
    expect(text).toContain("waggle_themes");
    expect(text).toContain("1. Use plain words");
  });

  test("repo records instruction only when on", () => {
    expect(projectGuide(base)).not.toContain("docs/decisions/");
    expect(projectGuide({ ...base, repoRecords: true })).toContain("docs/decisions/YYYY-MM-DD-<slug>.md");
  });

  test("stale is true with no proposal, false after one, true after more than 20 new comments", () => {
    const { store, task } = setup();
    expect(store.projects.themesStale("waggle")).toBe(true);
    store.projects.propose("waggle", "sess-1", [{ text: "T", evidence_count: 1, quotes: [] }], "2026-01-01T00:00:00.000Z");
    expect(store.projects.themesStale("waggle")).toBe(false);
    for (let i = 0; i < 21; i++) {
      const c = store.createCase(task.id, ask(`Q${i}?`)).id;
      decide(store, c, { choice: "a", message: `note ${i}` });
    }
    expect(store.projects.themesStale("waggle")).toBe(true);
    expect(store.projects.recentComments("waggle", 50)).toHaveLength(21);
  });
});

describe("project RPCs", () => {
  const homes: string[] = [];
  const servers: RpcServer[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
    for (const h of homes.splice(0)) rmrf(h);
  });

  test("get, decisions, toggle, repo switch, themes and the guide over the socket", async () => {
    const home = tmpHome();
    homes.push(home);
    const store = new Store(new Database(join(home, "knock.db")), home, new EventBus());
    const task = store.createTask({ name: "w", project: "waggle" });
    store.createSession(task.id, { id: "sess-1", cwd: "/work", branch: null, pid: 4242 });
    const c = store.createCase(task.id, ask("Layout?")).id;
    decide(store, c, { choice: "a" });
    const socketPath = join(home, "knock.sock");
    servers.push(startRpcServer({ socketPath, store, bus: new EventBus(), version: pkg.version }));
    const raw = await rpcConnect(socketPath);
    const client = {
      close: () => raw.close(),
      call: async (method: string, params: unknown) => {
        const res = await raw.request(method, params);
        if (res.error) throw new Error(String(res.error.message));
        return res.result;
      },
    };
    try {
      const prop = (await client.call("knock_themes", {
        session_id: "sess-1",
        action: "propose",
        themes: [{ text: "Plain words", evidence_count: 2, quotes: ["q"] }],
      })) as { added: { id: string }[] };
      expect(prop.added).toHaveLength(1);
      const got = (await client.call("project.get", { project: "waggle" })) as {
        decisions: number;
        repo_records: boolean;
        themes: { id: string; enabled: boolean }[];
      };
      expect(got.decisions).toBe(1);
      expect(got.repo_records).toBe(false);
      const off = (await client.call("project.theme_toggle", { id: got.themes[0]!.id, enabled: false })) as { enabled: boolean };
      expect(off.enabled).toBe(false);
      const list = (await client.call("project.decisions", { project: "waggle" })) as { items: { pick: string }[]; total: number };
      expect(list.total).toBe(1);
      await client.call("project.set_repo_records", { project: "waggle", enabled: true });
      const guide = (await client.call("guide.get", { topic: "project", session_id: "sess-1" })) as { text: string };
      expect(guide.text).toContain("docs/decisions/");
      expect(guide.text).toContain("Layout?");
      expect(guide.text).not.toContain("Plain words");
      await expect(client.call("project.theme_toggle", { id: "nope", enabled: true })).rejects.toBeDefined();
    } finally {
      client.close();
    }
  });

  test("scope all: propose, list, toggle and rules over the socket", async () => {
    const home = tmpHome();
    homes.push(home);
    const store = new Store(new Database(join(home, "knock.db")), home, new EventBus());
    const task = store.createTask({ name: "w", project: "waggle" });
    store.createSession(task.id, { id: "sess-1", cwd: "/work", branch: null, pid: 4242 });
    const socketPath = join(home, "knock.sock");
    servers.push(startRpcServer({ socketPath, store, bus: new EventBus(), version: pkg.version }));
    const raw = await rpcConnect(socketPath);
    const call = async (method: string, params: unknown) => {
      const res = await raw.request(method, params);
      if (res.error) throw new Error(String(res.error.message));
      return res.result;
    };
    try {
      const prop = (await call("knock_themes", {
        session_id: "sess-1",
        action: "propose",
        themes: [
          { text: "Local rule", evidence_count: 1, quotes: [] },
          { text: "Global rule", evidence_count: 3, quotes: ["q"], case_ids: ["c_1"], scope: "all" },
        ],
      })) as { added: { id: string; scope: string }[] };
      expect(prop.added.map((t) => t.scope)).toEqual(["project", "all"]);
      const all = (await call("preference.list", { scope: "all" })) as { items: { id: string; case_ids: string[] }[] };
      expect(all.items).toHaveLength(1);
      expect(all.items[0]!.case_ids).toEqual(["c_1"]);
      const proj = (await call("preference.list", { scope: "project", project: "waggle" })) as { items: { text: string }[] };
      expect(proj.items.map((t) => t.text)).toEqual(["Local rule"]);
      await expect(call("preference.list", { scope: "project" })).rejects.toBeDefined();
      expect(await call("preference.rules", { session_id: "sess-1" })).toEqual({ all: ["Global rule"], project: ["Local rule"] });
      await call("project.theme_toggle", { id: all.items[0]!.id, enabled: false });
      expect(await call("preference.rules", { session_id: "sess-1" })).toEqual({ all: [], project: ["Local rule"] });
      expect(await call("preference.rules", { session_id: "unknown" })).toEqual({ all: [], project: [] });
    } finally {
      raw.close();
    }
  });
});

// WAG-417: the learning trigger. 5 new corrections make the project guide ask for rules.
describe("corrections trigger", () => {
  function fixDecisions(store: Store, task: { id: string }, n: number, choice: string, tag = "Q") {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = store.createCase(task.id, ask(`${tag}${i}?`)).id;
      decide(store, c, { choice });
      ids.push(c);
    }
    return ids;
  }
  const guideOf = (store: Store) =>
    projectGuide({
      project: "waggle",
      decisions: [],
      themes: [],
      repoRecords: false,
      stale: false,
      comments: [],
      correctionsDue: store.projects.correctionsDue("waggle"),
      corrections: store.projects.correctedAsks("waggle"),
    });

  test("the constant is 5; no trigger at 4, trigger at 5", () => {
    const { store, task } = setup();
    expect(CORRECTION_TRIGGER_COUNT).toBe(5);
    fixDecisions(store, task, 4, "b");
    expect(store.projects.newCorrectionCount("waggle")).toBe(4);
    expect(guideOf(store)).not.toContain("Propose rules from the corrections");
    fixDecisions(store, task, 1, "b", "Extra");
    expect(store.projects.correctionsDue("waggle")).toBe(true);
    const text = guideOf(store);
    expect(text).toContain("Propose rules from the corrections");
    expect(text).toContain("case_ids");
    expect(text).toContain("WRONG:");
  });

  test("accepted recommendations are not corrections", () => {
    const { store, task } = setup();
    fixDecisions(store, task, 6, "a");
    expect(store.projects.correctionsDue("waggle")).toBe(false);
  });

  test("another project does not count", () => {
    const { store } = setup();
    const other = store.createTask({ name: "other", project: "elsewhere" });
    fixDecisions(store, other, 6, "b");
    expect(store.projects.correctionsDue("waggle")).toBe(false);
  });

  test("the list: newest first, question, recommendation and what the person did", () => {
    const { store, task } = setup();
    fixDecisions(store, task, 4, "b");
    const c = store.createCase(task.id, ask("Last one?")).id;
    decide(store, c, { choice: "b", message: "Too busy" });
    const list = store.projects.correctedAsks("waggle");
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ case_id: c, question: "Last one?", recommended: "Compact" });
    expect(list[0]!.outcome).toBe("picked Detailed; wrote: Too busy");
    expect(list[4]!.question).toBe("Q0?");
    const text = guideOf(store);
    expect(text).toContain(`1. [${c}] Last one? You recommended: Compact. The person: picked Detailed; wrote: Too busy.`);
  });

  test("the list holds 20 asks at most", () => {
    const { store, task } = setup();
    fixDecisions(store, task, 25, "b");
    const list = store.projects.correctedAsks("waggle");
    expect(list).toHaveLength(GUIDE_CORRECTION_COUNT);
    expect(list[0]!.question).toBe("Q24?");
    expect(store.projects.newCorrectionCount("waggle")).toBe(25);
  });

  test("a proposal restarts the counter", () => {
    const { store, task } = setup();
    fixDecisions(store, task, 5, "b");
    expect(store.projects.correctionsDue("waggle")).toBe(true);
    store.projects.propose("waggle", "sess-1", [{ text: "T", evidence_count: 1, quotes: [] }], new Date(Date.now() + 1000).toISOString());
    expect(store.projects.newCorrectionCount("waggle")).toBe(0);
    expect(store.projects.correctionsDue("waggle")).toBe(false);
    expect(store.projects.correctedAsks("waggle")).toHaveLength(0);
  });

  test("the comment trigger still works on its own", () => {
    const text = projectGuide({ project: "waggle", decisions: [], themes: [], repoRecords: false, stale: true, comments: ["Use plain words"] } as never);
    expect(text).toContain("Propose themes");
    expect(text).not.toContain("Propose rules from the corrections");
  });
});
