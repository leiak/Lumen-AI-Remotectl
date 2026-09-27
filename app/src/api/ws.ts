import type { BroadcastEvent } from './types';

export type WsEventName = BroadcastEvent['type'];
export type WsHandler<E extends WsEventName> = (e: Extract<BroadcastEvent, { type: E }>) => void;

export interface WsClientOpts {
  url: string;
  apiKey: string;
  factory?: (url: string, protocols?: string | string[]) => WebSocketLike;
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface WebSocketLike {
  on(event: 'open' | 'message' | 'close' | 'error', cb: (arg: any) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}

export class WsClient {
  private url: string;
  private apiKey: string;
  private factory: (url: string, protocols?: string | string[]) => WebSocketLike;
  private backoffMs: number;
  private maxBackoffMs: number;
  private handlers = new Map<WsEventName, Set<WsHandler<WsEventName>>>();
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WsClientOpts) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.backoffMs = opts.backoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    // Native browser WebSocket can't set custom headers. Until the server
    // accepts the auth token in a query string, we cannot authenticate a
    // browser WS upgrade at all. This client emits `?token=...` as the design
    // choice; the matching server-side support is tracked separately.
    const defaultFactory = (url: string) => {
      const ws = new WebSocket(url, [] as string[]);
      return ws as unknown as WebSocketLike;
    };
    this.factory = opts.factory ?? defaultFactory;
  }

  on<E extends WsEventName>(event: E, handler: WsHandler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    const anyHandler = handler as unknown as WsHandler<WsEventName>;
    set.add(anyHandler);
    return () => set!.delete(anyHandler);
  }

  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private openSocket(): void {
    // TODO(server-auth): the server currently rejects WS upgrades that don't
    // carry `Authorization: Bearer ...`. The native browser WebSocket API
    // cannot set custom headers, so we ship this client with a query-string
    // token workaround. A matching server change (accept ?token=... OR a
    // subprotocol) is required before this can talk to a real server.
    const urlWithToken = `${this.url}?token=${encodeURIComponent(this.apiKey)}`;
    const ws = this.factory(urlWithToken);
    this.ws = ws;
    ws.on('open', () => { this.retries = 0; });
    ws.on('message', (raw: any) => {
      let data: any;
      try { data = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
      if (typeof data !== 'object' || data === null || typeof data.type !== 'string') return;
      const set = this.handlers.get(data.type as WsEventName);
      if (!set) return;
      for (const h of set) h(data);
    });
    ws.on('close', () => {
      if (this.stopped) return;
      this.scheduleReconnect();
    });
    ws.on('error', () => {
      // The 'close' handler will fire after; let it handle reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * Math.pow(2, this.retries));
    this.retries++;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }
}
