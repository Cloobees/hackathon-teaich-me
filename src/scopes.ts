// The bot scopes the variant calls Slack with. A scope missing from the installed app fails quietly (the call is logged and
// skipped), and reinstalling does not add a scope that the app's own manifest in Slack lacks, so the start reports it.
export const REQUIRED_SCOPES = ["chat:write", "groups:write", "canvases:write", "pins:write", "bookmarks:write"] as const;

/** The required scopes absent from `granted`. Undefined `granted` (Slack sent none) means unknown, so nothing is reported. */
export function missingScopes(granted: readonly string[] | undefined, required: readonly string[] = REQUIRED_SCOPES): string[] {
  if (!granted) return [];
  return required.filter((scope) => !granted.includes(scope));
}
