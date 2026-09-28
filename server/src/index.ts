import express, { type Express } from 'express';
import { createServer } from 'node:http';
import type { Db } from './db/client.js';
import { issuesRouter } from './routes/issues.js';
import { commentsRouter } from './routes/comments.js';
import { pushRouter } from './routes/push.js';
import { BroadcastHub } from './ws/broadcast.js';
import { createWsServer } from './ws/server.js';
import { broadcastToWs, type RouteEvent } from './events/translate.js';
export { broadcastToWs, type RouteEvent } from './events/translate.js';
import type { NotifyKind, NotifyPayload } from './push/notify.js';
import type { PendingApprovals } from './scheduler/pending.js';

export interface CreateAppOpts {
  db: Db;
  apiKey: string;
  hub: BroadcastHub;
  httpPort: number;
  /**
   * Optional best-effort push notification hook (e.g. `notify` from
   * `./push/notify.js`). Today the runner isn't started inside `createApp`
   * itself, but the option is plumbed so callers (or a future wiring) can
   * forward it to `startLoop` from this same bootstrap.
   */
  notify?: (kind: NotifyKind, payload: NotifyPayload) => Promise<void>;
  /**
   * Shared registry of pending approval requests. The HTTP route consults
   * it to forward user yes/no to the awaiting runner. If omitted the route
   * still records the response comment but can't unblock any in-flight run.
   */
  pendingApprovals?: PendingApprovals;
}

export interface AppHandle {
  httpPort: number;
  wsPort: number;
  shutdown: () => Promise<void>;
}

export async function createApp(opts: CreateAppOpts): Promise<AppHandle> {
  // HTTP server with Express
  const expressApp: Express = express();
  // CORS: API is bearer-token protected, so allowing all origins is safe and
  // lets the web preview (Vite dev/preview on :5173) call the API (:8787).
  expressApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Translate route-layer events into the WS-layer event shape and fan them out through the hub.
  const routeBroadcast = (msg: RouteEvent) => broadcastToWs(opts.hub, msg);

  expressApp.use('/api/issues', issuesRouter(opts.db, opts.apiKey, routeBroadcast, opts.pendingApprovals));
  expressApp.use('/api/comments', commentsRouter(opts.db, opts.apiKey));
  expressApp.use('/api/push', pushRouter(opts.db, opts.apiKey));

  const httpServer = createServer(expressApp);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.httpPort, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const httpAddr = httpServer.address();
  const httpPort = typeof httpAddr === 'object' && httpAddr ? httpAddr.port : opts.httpPort;

  // WS server (same port as HTTP, so the phone browser can use the standard
  // same-origin WebSocket URL without a separate WS port setting).
  const ws = await createWsServer({ server: httpServer, apiKey: opts.apiKey, hub: opts.hub });

  return {
    httpPort,
    wsPort: ws.port,
    shutdown: async () => {
      await ws.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}