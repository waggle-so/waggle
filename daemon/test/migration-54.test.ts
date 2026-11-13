import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, migrate } from "../src/schema";

// WAG-410 pass 2: migration 54 widens the reply state CHECK with handed_over. Every reply, column and
// index is kept, and a rerun changes nothing.
test("migration 54 keeps replies and takes the handed_over state", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((x) => x.version <= 53)) {
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
           VALUES ('c1', 't1', 'question', 'T', 'N', 'W', 'a', 'R', '[]', 'waiting_on_agent', '2026-01-01', '2026-01-01')`);
  db.exec(`INSERT INTO replies (id, case_id, idempotency_key, choice, state, created_at, reason, item_answers_json, attachments_json)
           VALUES ('r1', 'c1', 'k1', 'a', 'failed', '2026-01-02', 'session_unreachable', '{"x":1}', '[]')`);
  expect(() => db.exec(`UPDATE replies SET state = 'handed_over' WHERE id = 'r1'`)).toThrow();
  migrate(db);
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(60);
  const row = db.query(`SELECT * FROM replies WHERE id = 'r1'`).get() as Record<string, unknown>;
  expect(row.state).toBe("failed");
  expect(row.reason).toBe("session_unreachable");
  expect(row.item_answers_json).toBe('{"x":1}');
  expect(row.attachments_json).toBe("[]");
  db.exec(`UPDATE replies SET state = 'handed_over', reason = NULL WHERE id = 'r1'`);
  expect((db.query(`SELECT state FROM replies WHERE id = 'r1'`).get() as { state: string }).state).toBe("handed_over");
  expect(() => db.exec(`UPDATE replies SET state = 'bogus' WHERE id = 'r1'`)).toThrow();
  expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'idx_replies_case'`).get()).toBeTruthy();
});
