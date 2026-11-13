import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, MIGRATIONS } from "../src/schema";

// WAG-367: migration 45 recreates usage to take the variant "screenshots". Every row of version 44
// and every column survives.
test("migration 45 keeps the usage rows and takes the new word", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS.filter((x) => x.version <= 44)) {
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      if (m.up) m.up(db);
      else db.exec(m.sql);
    })();
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec("PRAGMA user_version = 44");
  db.exec(
    `INSERT INTO usage (event, hour, n, variant, ask_h, format, intent, note, stage)
     VALUES ('detail_format_picked', '2026-10-13T10:00:00.000Z', 1, 'numbers', 'abcdef012345', 'none', NULL, NULL, NULL),
            ('reply_submitted', '2026-10-13T11:00:00.000Z', 0, NULL, 'abcdef012345', 'eli5', 'more_detail', '21-100', NULL),
            ('round_added', '2026-10-13T12:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, 'design')`,
  );
  expect(() => db.exec(`INSERT INTO usage (event, hour, variant) VALUES ('detail_format_picked', 'h', 'screenshots')`)).toThrow();
  const before = db.query(`SELECT * FROM usage ORDER BY hour`).all();
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(58);
  expect(db.query(`SELECT * FROM usage ORDER BY hour`).all()).toEqual(before);
  db.exec(`INSERT INTO usage (event, hour, variant) VALUES ('detail_format_picked', 'h', 'screenshots')`);
  const indexes = (db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage'`).all() as { name: string }[]).map((r) => r.name);
  expect(indexes.sort()).toEqual(["idx_usage_ask", "idx_usage_hour"]);
});
