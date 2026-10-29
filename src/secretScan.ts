import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The patterns of the environment spec, Scenario 2.
const PATTERNS: [string, RegExp][] = [
  ["slack-bot-token", /xoxb-[A-Za-z0-9-]{10,}/],
  ["slack-app-token", /xapp-[A-Za-z0-9-]{10,}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{10,}/],
];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export interface Finding {
  file: string;
  pattern: string;
}

/** Scans text files under the given paths. `.env` is skipped: it is the gitignored home of the real values. */
export function scanForSecrets(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) if (!SKIP_DIRS.has(name)) walk(join(path, name));
      return;
    }
    if (path.endsWith(".env") || /\.(png|jpg|db|exe)$/.test(path)) return;
    const text = readFileSync(path, "utf8");
    for (const [pattern, regex] of PATTERNS) if (regex.test(text)) findings.push({ file: path, pattern });
  };
  paths.forEach(walk);
  return findings;
}
