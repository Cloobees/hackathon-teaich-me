import type { ItemsConfig } from "./checklist.js";
import type { Logger } from "./log.js";
import type { SlackClient } from "./slack.js";
import type { Store } from "./store.js";

/** Everything a handler needs. Tests build one with a temporary store and a fake Slack client. */
export interface Deps {
  store: Store;
  slack: SlackClient;
  items: ItemsConfig;
  libraryDir: string;
  now: () => string;
  log: Logger;
  operators: string[];
  /** Link to the glossary canvas (GLOSSARY_CANVAS_URL); omitted from messages when unset. */
  glossaryUrl?: string;
  /** Path of the copilot-check zip the copilot attaches (SKILL_ZIP_PATH); sendSkillZip treats an unset path as a missing file. */
  skillZipPath?: string;
  /** What the member types after /invite (BOT_MENTION); `{botMention}` in an instruction is replaced by it. */
  botMention?: string;
  /** `owner/name` the I5 report must name (HARNESS_REPO); unset accepts any non-empty repo. */
  harnessRepo?: string;
  /** Surface for a member whose `canvas_surface` is unset (CHECKLIST_SURFACE); unset means `message`. */
  checklistSurface?: "canvas" | "message" | "both";
}
