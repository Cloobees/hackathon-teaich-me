import { readFileSync } from "node:fs";
import { findMock, loadMockList } from "../src/mockList.js";

// Usage: check:mocks [--strict] [transcript-file]. Strict fails on any open entry or any entry text in the transcript (FR-EN-013).
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const transcriptPath = args.find((a) => !a.startsWith("--"));
const listPath = process.env.MOCK_LIST || "docs/mock-behaviours.md";

let problems: string[] = [];
try {
  const list = loadMockList(listPath);
  console.log(`mock list ${listPath}: ${list.length} entries (${list.filter((e) => e.status === "open").length} open)`);
  if (strict) {
    problems = list.filter((e) => e.status === "open").map((e) => `open entry: ${e.title}`);
    if (transcriptPath) {
      problems.push(...findMock(readFileSync(transcriptPath, "utf8"), list).map((e) => `mock text in ${transcriptPath}: ${e.title}`));
    }
  }
} catch (error) {
  problems = [(error as Error).message];
}
if (problems.length) {
  console.error("mock check failed:");
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log("mock check passed");
