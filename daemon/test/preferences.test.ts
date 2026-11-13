import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventBus } from "../src/events";
import { MIGRATIONS, migrate } from "../src/schema";
import { Store } from "../src/store";
import { DECISION_BLOCK_MAX_LINES, decisionBlock, instructionsFor, type DecisionRules } from "../src/protocol/mcp";

// WAG-415 (Waggle Brain): preferences with a scope, and the "How this person decides" connect block.

function store() {
  return new Store(new Database(":memory:"), "/tmp/knock-test", new EventBus());
}

describe("migration 60", () => {
  test("moves every project_themes row to a preference with scope project, nothing lost", () => {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS.filter((x) => x.version <= 58)) {
      if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
      db.transaction(() => (m.up ? m.up(db) : db.exec(m.sql)))();
      if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
    }
    db.exec("PRAGMA user_version = 58");
    const ins = db.query(
      `INSERT INTO project_themes (id, project, text, evidence_count, quotes_json, enabled, proposed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("th_1", "waggle", "Plain words", 4, '["a","b"]', 1, "sess-1", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    ins.run("th_2", "waggle", "Dark chrome", 2, "[]", 0, null, "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    ins.run("th_3", "other", "Tight rows", 1, '["q"]', 1, "sess-9", "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z");
    migrate(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(60);
    const rows = db.query(`SELECT * FROM preferences ORDER BY id`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: "th_1", scope: "project", project: "waggle", text: "Plain words", evidence_count: 4,
      quotes_json: '["a","b"]', case_ids_json: "[]", enabled: 1, proposed_by: "sess-1",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    });
    expect(rows[1]).toMatchObject({ id: "th_2", enabled: 0, proposed_by: null, scope: "project" });
    expect(rows[2]).toMatchObject({ id: "th_3", project: "other", quotes_json: '["q"]' });
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'project_themes'`).all()).toHaveLength(0);
  });

  test("a preference with scope all has no project; scope project needs one", () => {
    const db = new Database(":memory:");
    migrate(db);
    const ins = (scope: string, project: string | null) =>
      db.query(`INSERT INTO preferences (id, scope, project, text, created_at, updated_at) VALUES (?, ?, ?, 't', 'x', 'x')`).run(
        `p_${Math.random()}`, scope, project,
      );
    expect(() => ins("all", null)).not.toThrow();
    expect(() => ins("all", "waggle")).toThrow();
    expect(() => ins("project", null)).toThrow();
    expect(() => ins("global", null)).toThrow();
  });
});

describe("propose with a scope", () => {
  test("default scope is project; scope all belongs to no project and keeps evidence", () => {
    const s = store();
    const r = s.projects.propose("waggle", "sess-1", [
      { text: "Plain words", evidence_count: 2, quotes: ["q1"] },
      { text: "Never ship without a test", evidence_count: 5, quotes: ["q2", "q3"], case_ids: ["c_1", "c_2"], scope: "all" },
    ]);
    expect(r.added.map((t) => t.scope)).toEqual(["project", "all"]);
    expect(s.projects.themes("waggle").map((t) => t.text)).toEqual(["Plain words"]);
    expect(s.projects.themes("other")).toHaveLength(0);
    const all = s.projects.allThemes();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ scope: "all", quotes: ["q2", "q3"], case_ids: ["c_1", "c_2"], evidence_count: 5 });
    const row = s.db.query(`SELECT project FROM preferences WHERE id = ?`).get(all[0]!.id) as { project: string | null };
    expect(row.project).toBeNull();
  });

  test("a merge keeps the scope and adds quotes and cases", () => {
    const s = store();
    s.projects.propose("a", null, [{ text: "Plain words", evidence_count: 1, quotes: ["x"], case_ids: ["c_1"], scope: "all" }]);
    const r = s.projects.propose("b", null, [{ text: "plain words, always", evidence_count: 3, quotes: ["y"], case_ids: ["c_2"], scope: "all" }]);
    expect(r.added).toHaveLength(0);
    expect(r.merged[0]).toMatchObject({ scope: "all", evidence_count: 3, quotes: ["x", "y"], case_ids: ["c_1", "c_2"] });
    expect(s.projects.allThemes()).toHaveLength(1);
  });

  test("the same text in two scopes makes two preferences", () => {
    const s = store();
    s.projects.propose("a", null, [{ text: "Plain words", evidence_count: 1, quotes: [] }]);
    s.projects.propose("a", null, [{ text: "Plain words", evidence_count: 1, quotes: [], scope: "all" }]);
    expect(s.projects.themes("a")).toHaveLength(1);
    expect(s.projects.allThemes()).toHaveLength(1);
  });

  for (const scope of ["project", "all"] as const) {
    test(`a turned-off ${scope} rule stays off when the same text comes again`, () => {
      const s = store();
      const first = s.projects.propose("waggle", null, [{ text: "Dark chrome", evidence_count: 1, quotes: [], scope }]).added[0]!;
      expect(s.projects.setThemeEnabled(first.id, false)!.enabled).toBe(false);
      const again = s.projects.propose("waggle", null, [{ text: "dark chrome", evidence_count: 4, quotes: ["z"], scope }]);
      expect(again.added).toHaveLength(0);
      expect(again.merged[0]).toMatchObject({ id: first.id, enabled: false, evidence_count: 4 });
      const rules = s.projects.ruleTexts("waggle");
      expect([...rules.all, ...rules.project]).toEqual([]);
    });
  }
});

describe("connect block", () => {
  const rules = (all: string[], project: string[]): DecisionRules => ({ all, project });

  test("with rules: all first, then the project", () => {
    const text = decisionBlock(rules(["Plain words."], ["Dark chrome.", "Tight rows."]));
    expect(text).toMatchSnapshot();
  });

  test("without rules there is no block", () => {
    expect(decisionBlock(rules([], []))).toBeNull();
    expect(decisionBlock(undefined)).toBeNull();
    expect(instructionsFor("claude", undefined, false, rules([], []))).toBe(instructionsFor("claude"));
  });

  test("over 30 rules: at most 30 lines, all rules first, project rules cut", () => {
    const all = Array.from({ length: 5 }, (_, i) => `All rule ${i}`);
    const project = Array.from({ length: 40 }, (_, i) => `Project rule ${i}`);
    const text = decisionBlock(rules(all, project))!;
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(DECISION_BLOCK_MAX_LINES);
    expect(lines.length).toBe(DECISION_BLOCK_MAX_LINES);
    expect(lines.slice(2, 7)).toEqual(all.map((r) => `- ${r}`));
    expect(text).toContain("Project rule 20");
    expect(text).not.toContain("Project rule 23");
    expect(text).toMatchSnapshot();
  });

  test("a long or multi-line rule stays one line", () => {
    const text = decisionBlock(rules(["Line one\nline two " + "x".repeat(400)], []))!;
    expect(text.split("\n")).toHaveLength(3);
    expect(text.split("\n")[2]!.length).toBeLessThanOrEqual(2 + 200);
  });

  test("two projects: a session sees all rules and its own project rules only", () => {
    const s = store();
    const tx = s.createTask({ name: "x", project: "px" });
    s.createSession(tx.id, { id: "sx", cwd: "/x", branch: null, pid: 1 });
    const ty = s.createTask({ name: "y", project: "py" });
    s.createSession(ty.id, { id: "sy", cwd: "/y", branch: null, pid: 2 });
    s.projects.propose("px", "sx", [
      { text: "Rule for X", evidence_count: 1, quotes: ["secret quote X"], case_ids: ["c_x"] },
      { text: "Rule for everyone", evidence_count: 1, quotes: ["secret quote all"], case_ids: ["c_all"], scope: "all" },
    ]);
    const off = s.projects.propose("px", "sx", [{ text: "Off rule X", evidence_count: 1, quotes: [] }]).added[0]!;
    s.projects.setThemeEnabled(off.id, false);
    s.projects.propose("py", "sy", [{ text: "Rule for Y", evidence_count: 1, quotes: [] }]);
    const forX = instructionsFor("claude", undefined, false, s.projects.ruleTexts(s.projects.sessionProject("sx")));
    const forY = instructionsFor("claude", undefined, false, s.projects.ruleTexts(s.projects.sessionProject("sy")));
    expect(forX).toContain("## How this person decides\n\n- Rule for everyone\n- Rule for X");
    expect(forX).not.toContain("Rule for Y");
    expect(forX).not.toContain("Off rule X");
    expect(forY).toContain("## How this person decides\n\n- Rule for everyone\n- Rule for Y");
    expect(forY).not.toContain("Rule for X");
    for (const text of [forX, forY]) {
      expect(text).not.toContain("secret quote");
      expect(text).not.toContain("c_x");
      expect(text).not.toContain("c_all");
    }
    expect(s.projects.ruleTexts(null)).toEqual({ all: ["Rule for everyone"], project: [] });
  });

  test("the ask preferences stay, and the block comes after them", () => {
    const text = instructionsFor("claude", "My ask text", false, rules(["R"], []));
    expect(text).toContain("## Operator preferences · asks\n\nMy ask text\n\n## How this person decides\n\n- R");
  });
});
