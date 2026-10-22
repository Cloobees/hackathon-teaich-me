// POC: in-memory only, so sessions are lost on restart.
const sessions = new Map<string, string>();

export const getSession = (threadKey: string) => sessions.get(threadKey);
export const setSession = (threadKey: string, sessionId: string) => {
  sessions.set(threadKey, sessionId);
};
