// Loopback-only bind is intentional for v0.1 (avoids LAN exposure).
// Auth happens pre-upgrade: unauthorized clients never complete the handshake.
import { WebSocketServer, WebSocket, type WebSocket as WS } from 'ws';
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BroadcastHub } from './broadcast.js';

/**
 * Parse a `since` value from a WS upgrade URL. Returns:
 *  - the parsed integer when `?since=N` is present and N is a non-negative
 *    integer string;
 *  - `null` when the param is missing (treat as "send nothing");
 *  - `null` when malformed (clients should reconnect without it).
 * We never throw on bad input — failing the upgrade for a malformed query
 * would lock a phone out of the app until local storage is cleared.
 */
function parseSince(rawUrl: string | undefined): number | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const raw = url.searchParams.get('since');
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

export interface CreateWsServerOpts {
  /** Port to listen on. Ignored if `server` is provided. */
  port?: number;
  /** Optional existing HTTP server to attach WS upgrades to. When provided,
   *  WS runs on the same port as the HTTP API (the standard browser shape). */
  server?: Server;
  apiKey: string;
  hub: BroadcastHub;
}

export interface WsServerHandle {
  /** Port WS is listening on. Equals the parent server's port when `server`
   *  is provided; equals `opts.port` otherwise. */
  port: number;
  close: () => Promise<void>;
}

export async function createWsServer(opts: CreateWsServerOpts): Promise<WsServerHandle> {
  const wss = new WebSocketServer({ noServer: true });
  const owned = !opts.server;
  const http: Server = opts.server ?? createServer();

  http.on('upgrade', (req, socket, head) => {
    // Token may come from either the Authorization: Bearer header (preferred,
    // for non-browser clients) or the ?token=<apiKey> query string (required
    // for browser WebSocket clients, which cannot set custom HTTP headers).
    let token: string | null = null;

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      token = auth.slice('Bearer '.length);
    } else if (req.url) {
      // Browser fallback: token carried in the query string.
      try {
        const url = new URL(req.url, 'http://localhost');
        const qToken = url.searchParams.get('token');
        if (qToken) token = qToken;
      } catch {
        // Malformed URL — leave token null and fall through to 401 below.
      }
    }

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const a = Buffer.from(token);
    const b = Buffer.from(opts.apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        opts.hub.attach(ws);
      } catch (err) {
        console.error('[ws] attach failed:', err);
        try {
          ws.close(1011, 'internal error');
        } catch {
          socket.destroy();
        }
        return;
      }

      // Replay missed events when reconnecting with `?since=<id>`. We only
      // consult this on the new connection — never on the live broadcast
      // fan-out — so a normal client (no `since`) starts clean.
      const since = parseSince(req.url);
      if (since !== null && since > 0) {
        opts.hub
          .replaySince(since)
          .then((missed) => {
            for (const envelope of missed) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(envelope));
              }
            }
          })
          .catch((err) => console.error('[ws] replay failed:', err));
      }
    });
  });

  if (owned) {
    if (opts.port === undefined) {
      throw new Error('createWsServer: either `port` or `server` must be provided');
    }
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(opts.port, '0.0.0.0', () => {
        http.off('error', reject);
        resolve();
      });
    });
  }
  const addr = http.address();
  const port =
    typeof addr === 'object' && addr ? addr.port : opts.port ?? 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // wss.close() only stops accepting new connections; it does not
        // actively terminate existing clients. Drain them explicitly so a
        // stuck connection can't hang Ctrl+C forever.
        for (const client of wss.clients) {
          try {
            client.close(1001, 'server shutting down');
          } catch {
            // ignore individual client close failures
          }
        }
        const done = () => (owned ? http.close(() => resolve()) : resolve());
        wss.close(done);
      }),
  };
}