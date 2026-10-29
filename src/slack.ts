// The narrow slice of the Slack Web API the copilot uses. Every handler takes this, so tests pass a fake
// and Bolt passes its client (see app.ts).
export type Block = Record<string, unknown>;

export interface SlackClient {
  conversations: { open(args: { users: string }): Promise<{ channel?: { id?: string } }> };
  chat: {
    postMessage(args: { channel: string; text: string; blocks?: Block[]; thread_ts?: string }): Promise<{ ts?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: Block[] }): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<{ user?: { profile?: { email?: string } } }>;
    list(args: { cursor?: string }): Promise<{
      members?: { id?: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}
