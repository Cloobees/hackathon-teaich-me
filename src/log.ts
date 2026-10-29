// One line per event: `{"ts":...,"event":...,...fields}`. Secret-shaped values are replaced, never printed.
const SECRET = /xox[abprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]+/g;

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (event: string, fields?: LogFields) => void;

export function formatLine(event: string, fields: LogFields = {}, now = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), event, ...fields }).replace(SECRET, "[redacted]");
}

export const log: Logger = (event, fields) => console.log(formatLine(event, fields));
