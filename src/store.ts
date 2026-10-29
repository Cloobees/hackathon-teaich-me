import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "technical" | "non-technical";
export type Method = "observed" | "validated" | "self-attested";
type Param = string | number | null;

// The SQLite library stays behind this interface (DD-EN-006): swapping it changes this file only.
export interface Store {
  /** Runs a write; returns the number of rows changed. */
  run(sql: string, ...params: Param[]): number;
  get<T>(sql: string, ...params: Param[]): T | undefined;
  all<T>(sql: string, ...params: Param[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

// Item ids sort in item order (I1 to I6), so MIN(item_id) over pending rows is the lowest-order pending item.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS member (
  member_id TEXT PRIMARY KEY,
  role TEXT,
  role_chosen_at TEXT,
  started_by TEXT,
  dm_channel_id TEXT,
  welcome_ts TEXT,
  checklist_ts TEXT,
  completed_at TEXT,
  seeded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checklist_item (
  member_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  method TEXT,
  ticked_at TEXT,
  evidence_ref TEXT,
  PRIMARY KEY (member_id, item_id)
);
CREATE TABLE IF NOT EXISTS processed_event (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_nonce (
  nonce TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  used_at TEXT
);
CREATE VIEW IF NOT EXISTS v_started_completed AS
  SELECT role, seeded, COUNT(*) AS started,
         SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
  FROM member WHERE role IS NOT NULL GROUP BY role, seeded;
CREATE VIEW IF NOT EXISTS v_in_progress AS
  SELECT role, seeded, COUNT(*) AS in_progress
  FROM member WHERE role IS NOT NULL AND completed_at IS NULL GROUP BY role, seeded;
CREATE VIEW IF NOT EXISTS v_waiting AS
  SELECT m.role AS role, m.seeded AS seeded, f.first_pending AS item_id, COUNT(*) AS members
  FROM member m
  JOIN (SELECT member_id, MIN(item_id) AS first_pending FROM checklist_item WHERE status = 'pending' GROUP BY member_id) f
    ON f.member_id = m.member_id
  WHERE m.role IS NOT NULL AND m.completed_at IS NULL
  GROUP BY m.role, m.seeded, f.first_pending;
CREATE VIEW IF NOT EXISTS v_item_ticks AS
  SELECT m.role AS role, m.seeded AS seeded, c.item_id AS item_id, COUNT(*) AS ticks
  FROM checklist_item c JOIN member m ON m.member_id = c.member_id
  WHERE c.status = 'ticked' AND m.role IS NOT NULL GROUP BY m.role, m.seeded, c.item_id;
CREATE VIEW IF NOT EXISTS v_item_methods AS
  SELECT m.role AS role, m.seeded AS seeded, c.item_id AS item_id, c.method AS method, COUNT(*) AS ticks
  FROM checklist_item c JOIN member m ON m.member_id = c.member_id
  WHERE c.status = 'ticked' AND m.role IS NOT NULL GROUP BY m.role, m.seeded, c.item_id, c.method;
`;

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return {
    run: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
    get: <T>(sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
