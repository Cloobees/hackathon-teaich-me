import { checkLibrary } from "../src/library.js";

const dir = process.argv[2] || process.env.LIBRARY_DIR || "library";
const problems = checkLibrary(dir);
if (problems.length) {
  console.error(`library check failed for ${dir}:`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(`library check passed for ${dir}`);
