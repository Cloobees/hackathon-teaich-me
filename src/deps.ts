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
  /** Channel the member's Claude posts report blocks in (CHECK_CHANNEL_ID); the check button is off when unset. */
  checkChannelId?: string;
  /** The paste fallback (REPORT_PASTE_FALLBACK, default off): the check click asks for the block pasted into the DM, and the DM listener reads it. */
  reportPasteFallback?: boolean;
  /** Path of the copilot-check zip the copilot attaches (SKILL_ZIP_PATH); sendSkillZip treats an unset path as a missing file. */
  skillZipPath?: string;
}
