import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, migrate } from "../src/schema";

// WAG-387: migration 48 adds the sharing tables. Old data is untouched and a rerun changes nothing.
test("migration 48 adds the sharing tables and cascades with the case", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((x) => x.version <= 47)) {
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      if (m.up) m.up(db);
      else db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec(`INSERT INTO tasks (id, name, project, created_at) VALUES ('t1', 't', 'p', '2026-01-01')`);
  db.exec(`INSERT INTO cases (id, task_id, kind, title, need, why, recommendation, recommendation_why, options_json, status, created_at, updated_at)
           VALUES ('c1', 't1', 'question', 'T', 'N', 'W', 'a', 'R', '[]', 'needs_you', '2026-01-01', '2026-01-01')`);
  migrate(db);
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(60);
  db.exec(`INSERT INTO relay_shares (case_id, relay_id, url, mode, created_at) VALUES ('c1', 'r1', 'https://x/d/r1', 'link', 'now')`);
  db.exec(`INSERT INTO relay_comments (id, case_id, round_seq, author_name, author_kind, body, created_ms) VALUES ('k1', 'c1', 1, 'Ada', 'guest', 'hi', 5)`);
  expect(() => db.exec(`UPDATE relay_shares SET mode = 'public' WHERE case_id = 'c1'`)).toThrow();
  db.exec(`DELETE FROM cases WHERE id = 'c1'`);
  expect(db.query(`SELECT COUNT(*) AS n FROM relay_comments`).get()).toEqual({ n: 0 });
  expect(db.query(`SELECT COUNT(*) AS n FROM relay_shares`).get()).toEqual({ n: 0 });
});
