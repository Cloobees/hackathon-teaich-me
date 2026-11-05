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
  checklist_ts TEXT,
  completed_at TEXT,
  seeded INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  channel_name TEXT,
  channel_state TEXT,
  checklist_canvas_id TEXT,
  canvas_surface TEXT
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

// Retired columns of earlier schemas (FR-CH-025, BP-108). Each is dropped only while it is present, so a reopen changes nothing.
const RETIRED_MEMBER_COLUMNS = ["report_channel_id", "report_channel_name", "first_message_ts", "welcome_ts", "pin_refused"];
const CHANNEL_COLUMNS = ["channel_id", "channel_name", "channel_state", "checklist_canvas_id", "canvas_surface"];

/** Brings a member table made by any earlier schema to the current one: add, then copy the report channel, then drop. */
function migrateMember(db: DatabaseSync): void {
  const read = () => (db.prepare("PRAGMA table_info(member)").all() as { name: string }[]).map((c) => c.name);
  db.exec("BEGIN");
  try {
    const columns = read();
    for (const column of CHANNEL_COLUMNS) {
      if (!columns.includes(column)) db.exec(`ALTER TABLE member ADD COLUMN ${column} TEXT`);
    }
    // Copy first, while the old columns exist; a row that already has a channel_id is left alone.
    if (columns.includes("report_channel_id")) {
      const name = columns.includes("report_channel_name") ? "report_channel_name" : "NULL";
      db.exec(
        `UPDATE member SET channel_id = report_channel_id, channel_name = ${name}, channel_state = 'active' WHERE channel_id IS NULL AND report_channel_id IS NOT NULL`,
      );
    }
    // SQLite refuses to drop a column an index names, so a hand-made index on a retired column goes first.
    const indexes = db.prepare("PRAGMA index_list(member)").all() as { name: string; origin: string }[];
    for (const index of indexes.filter((i) => i.origin === "c")) {
      const named = (db.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string | null }[]).map((c) => c.name);
      if (named.some((n) => n !== null && RETIRED_MEMBER_COLUMNS.includes(n))) db.exec(`DROP INDEX "${index.name}"`);
    }
    for (const column of RETIRED_MEMBER_COLUMNS) {
      if (columns.includes(column)) db.exec(`ALTER TABLE member DROP COLUMN ${column}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrateMember(db);
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

export type ChannelState = "active" | "member_left" | "invite_failed" | "lost";

export interface MemberChannel {
  id: string | null;
  name: string | null;
  state: ChannelState | null;
}

/** Stores the member's channel id, name and state together; the row must exist. */
export function setMemberChannel(store: Store, memberId: string, channel: { id: string | null; name: string | null; state: ChannelState }): void {
  store.run("UPDATE member SET channel_id = ?, channel_name = ?, channel_state = ? WHERE member_id = ?", channel.id, channel.name, channel.state, memberId);
}

export function getMemberChannel(store: Store, memberId: string): MemberChannel | undefined {
  const row = store.get<{ channel_id: string | null; channel_name: string | null; channel_state: ChannelState | null }>(
    "SELECT channel_id, channel_name, channel_state FROM member WHERE member_id = ?",
    memberId,
  );
  return row && { id: row.channel_id, name: row.channel_name, state: row.channel_state };
}
