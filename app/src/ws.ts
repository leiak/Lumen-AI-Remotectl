import { storage } from './storage';

type Handler = (msg: any) => void;
interface WsClientOpts {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Build a `ws://host:port/path?token=...` URL from an `http(s)://host:port`
 * base URL and an apiKey. Centralized so the URL shape has one source of truth
 * (avoids fragile `replace(/^http/, 'ws')` tricks that break on `https://`).
 */
function hostWsUrl(host: string, apiKey: string): string {
  const scheme = host.startsWith('https://') ? 'wss://' : 'ws://';
  const base = host.replace(/^https?:\/\//, '');
  return `${scheme}${base}/ws?token=${encodeURIComponent(apiKey)}`;
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

    const url = hostWsUrl(host, apiKey);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      // TODO(server-since): server doesn't yet honor `since` — kept for
      // forward compatibility. Once the server attaches a monotonic
      // `event_id` to each broadcast and stores a per-connection resume
      // cursor, this client will automatically resume from the last
      // seen event on reconnect.
      ws.send(JSON.stringify({ kind: 'hello', since: storage.getLastEventId() }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg && typeof msg === 'object' && typeof msg.event_id === 'number') {
          storage.setLastEventId(Math.max(storage.getLastEventId(), msg.event_id));
        }
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // close will fire next; let it handle reconnect.
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.getBackoffMs();
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}