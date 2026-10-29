import { scanForSecrets } from "../src/secretScan.js";

// Default targets are this repo, the workspace scratch folder and the evidence folder (environment spec, Scenario 2).
const paths = process.argv.length > 2 ? process.argv.slice(2) : [".", "../.tmp", "../.claude/evidence"];
const findings = scanForSecrets(paths);
if (findings.length) {
  for (const f of findings) console.error(`secret-shaped value (${f.pattern}) in ${f.file}`);
  process.exit(1);
}
console.log(`no secret-shaped values in ${paths.join(", ")}`);
