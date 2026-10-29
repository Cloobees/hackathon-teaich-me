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
}
