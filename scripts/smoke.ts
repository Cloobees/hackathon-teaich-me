import { runTurn } from "../src/agent.js";
import { loadAgentConfig } from "../src/config.js";

// Runs one agent turn without Slack: the Slack client is a stub that logs.
const text = process.argv.slice(2).join(" ") || "Which Context Builder scopes do I have access to?";
const client = {
  chat: {
    postMessage: async (a: { text: string }) => (console.log("[slack post]", a.text), { ts: "1" }),
    update: async (a: { text: string }) => console.log("[slack update]", a.text),
  },
};

const reply = await runTurn(loadAgentConfig(), {
  threadKey: "smoke",
  text,
  slack: { client, channel: "C0", threadTs: "1" },
});
console.log("\n--- reply ---\n" + reply);
