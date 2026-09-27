// Loopback-only bind is intentional for v0.1 (avoids LAN exposure).
// Auth happens pre-upgrade: unauthorized clients never complete the handshake.
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BroadcastHub } from './broadcast.js';

export interface CreateWsServerOpts {
  port: number;
  apiKey: string;
  hub: BroadcastHub;
}

export interface WsServerHandle {
  port: number;
  close: () => Promise<void>;
}

export async function createWsServer(opts: CreateWsServerOpts): Promise<WsServerHandle> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });

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
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

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
        wss.close(() => http.close(() => resolve()));
      }),
  };
}