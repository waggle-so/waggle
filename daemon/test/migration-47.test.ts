import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, MIGRATIONS } from "../src/schema";

// WAG-384: migration 47 recreates usage to take the variant "how_it_works". Rows and indexes survive.
test("migration 47 keeps the usage rows and takes the new word", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS.filter((x) => x.version <= 46)) {
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      if (m.up) m.up(db);
      else db.exec(m.sql);
    })();
    if (m.recreatesReferencedTable) db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec("PRAGMA user_version = 46");
  db.exec(
    `INSERT INTO usage (event, hour, n, variant, format) VALUES ('detail_format_picked', '2026-10-17T10:00:00.000Z', 1, 'screenshots', 'none')`,
  );
  expect(() => db.exec(`INSERT INTO usage (event, hour, variant) VALUES ('detail_format_picked', 'h', 'how_it_works')`)).toThrow();
  const before = db.query(`SELECT * FROM usage ORDER BY hour`).all();
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(58);
  expect(db.query(`SELECT * FROM usage ORDER BY hour`).all()).toEqual(before);
  db.exec(`INSERT INTO usage (event, hour, variant) VALUES ('detail_format_picked', 'h', 'how_it_works')`);
  const indexes = (db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage'`).all() as { name: string }[]).map((r) => r.name);
  expect(indexes.sort()).toEqual(["idx_usage_ask", "idx_usage_hour"]);
});
