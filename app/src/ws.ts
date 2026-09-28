import { storage } from './storage';

type Handler = (msg: any) => void;
interface WsClientOpts {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Build a `ws://host:port/path?token=...&since=<id>` URL from an
 * `http(s)://host:port` base URL, an apiKey, and the last seen event id.
 * Centralized so the URL shape has one source of truth (avoids fragile
 * `replace(/^http/, 'ws')` tricks that break on `https://`).
 *
 * `since` is the high-water mark of event_ids the client has already
 * rendered; the server replays anything strictly greater on upgrade so
 * a phone that woke up after a brief disconnect doesn't miss frames.
 */
function hostWsUrl(host: string, apiKey: string, since: number): string {
  const scheme = host.startsWith('https://') ? 'wss://' : 'ws://';
  const base = host.replace(/^https?:\/\//, '');
  const tail = since > 0 ? `&since=${since}` : '';
  return `${scheme}${base}/ws?token=${encodeURIComponent(apiKey)}${tail}`;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private opts: Required<WsClientOpts>;

  constructor(opts: WsClientOpts = {}) {
    this.opts = {
      baseBackoffMs: opts.baseBackoffMs ?? 1000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
    };
  }

  onMessage(h: Handler): () => void {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  getBackoffMs(): number {
    return Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * Math.pow(2, this.attempt));
  }

  getLastEventId(): number {
    return storage.getLastEventId();
  }

  connect(): void {
    const host = storage.getHost();
    const apiKey = storage.getApiKey();
    if (!host || !apiKey) return;
    this.stopped = false;
    this.attempt = 0;

    const since = storage.getLastEventId();
    const url = hostWsUrl(host, apiKey, since);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Server wraps every broadcast in `{event_id, event}` (see
        // server/src/ws/broadcast.ts). Unwrap so handlers receive the inner
        // payload — they expect a flat BroadcastEvent shape, not an envelope.
        // `event_id` is tracked separately so the replay cursor advances
        // correctly even on legacy frames that came in flat.
        let payload: any = msg;
        if (msg && typeof msg === 'object' && msg.event && typeof msg.event === 'object') {
          if (typeof msg.event_id === 'number') {
            storage.setLastEventId(Math.max(storage.getLastEventId(), msg.event_id));
          }
          payload = msg.event;
        } else if (msg && typeof msg === 'object' && typeof msg.event_id === 'number') {
          storage.setLastEventId(Math.max(storage.getLastEventId(), msg.event_id));
        }
        for (const h of this.handlers) h(payload);
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Standard browser fires 'close' next, but some mobile WebViews can drop 'close' — safety net.
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.getBackoffMs();
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}