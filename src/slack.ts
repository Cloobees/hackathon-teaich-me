// The narrow slice of the Slack Web API the copilot uses. Every handler takes this, so tests pass a fake
// and Bolt passes its client (see app.ts).
export type Block = Record<string, unknown>;

export interface SlackClient {
  conversations: {
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
    info(args: { channel: string }): Promise<{
      channel?: { id?: string; name?: string; is_private?: boolean; is_group?: boolean; is_archived?: boolean };
    }>;
    create(args: { name: string; is_private?: boolean }): Promise<{ channel?: { id?: string; name?: string; context_team_id?: string } }>;
    invite(args: { channel: string; users: string }): Promise<unknown>;
    rename(args: { channel: string; name: string }): Promise<unknown>;
    archive(args: { channel: string }): Promise<unknown>;
    canvases: {
      create(args: { channel_id: string; title?: string; document_content?: { type: "markdown"; markdown: string } }): Promise<{ canvas_id?: string }>;
    };
  };
  chat: {
    postMessage(args: { channel: string; text: string; blocks?: Block[]; thread_ts?: string }): Promise<{ ts?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: Block[] }): Promise<unknown>;
  };
  canvases: {
    create(args: { title?: string; document_content?: { type: "markdown"; markdown: string } }): Promise<{ canvas_id?: string }>;
    access: { set(args: { canvas_id: string; access_level: "read" | "write"; channel_ids: string[] }): Promise<unknown> };
    sections: {
      lookup(args: { canvas_id: string; criteria: { section_types?: string[]; contains_text?: string } }): Promise<{ sections?: { id?: string }[] }>;
    };
    edit(args: { canvas_id: string; changes: Record<string, unknown>[] }): Promise<unknown>;
  };
  pins: { add(args: { channel: string; timestamp: string }): Promise<unknown> };
  bookmarks: { add(args: { channel_id: string; title: string; type: "link"; link: string; emoji?: string }): Promise<unknown> };
  views: { publish(args: { user_id: string; view: { type: "home"; blocks: Block[] } }): Promise<unknown> };
  files: {
    uploadV2(args: { channel_id: string; file: Buffer; filename: string; initial_comment?: string }): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<{
      user?: { real_name?: string; profile?: { email?: string; real_name?: string; display_name?: string } };
    }>;
    list(args: { cursor?: string }): Promise<{
      members?: { id?: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}
