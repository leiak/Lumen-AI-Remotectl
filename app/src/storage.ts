const HOST_KEY = 'remotectl.host';
const API_KEY = 'remotectl.apiKey';
const LAST_EVENT_ID = 'remotectl.lastEventId';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota or denied */ }
}
function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* */ }
}

export const storage = {
  getHost(): string | null {
    return safeGet(HOST_KEY);
  },
  setHost(host: string): void {
    safeSet(HOST_KEY, host);
  },
  getApiKey(): string | null {
    return safeGet(API_KEY);
  },
  setApiKey(key: string): void {
    safeSet(API_KEY, key);
  },
  getLastEventId(): number {
    const s = safeGet(LAST_EVENT_ID);
    return s ? Number(s) || 0 : 0;
  },
  setLastEventId(id: number): void {
    safeSet(LAST_EVENT_ID, String(id));
  },
  clear(): void {
    safeRemove(HOST_KEY);
    safeRemove(API_KEY);
    safeRemove(LAST_EVENT_ID);
  },
};