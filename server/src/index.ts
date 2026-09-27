import express, { type Express } from 'express';
import { createServer } from 'node:http';
import type { Db } from './db/client.js';
import { issuesRouter } from './routes/issues.js';
import { commentsRouter } from './routes/comments.js';
import { BroadcastHub } from './ws/broadcast.js';
import { createWsServer } from './ws/server.js';

export interface CreateAppOpts {
  db: Db;
  apiKey: string;
  hub: BroadcastHub;
  httpPort: number;
  wsPort: number;
}

export interface AppHandle {
  httpPort: number;
  wsPort: number;
  shutdown: () => Promise<void>;
}

export async function createApp(opts: CreateAppOpts): Promise<AppHandle> {
  // HTTP server with Express
  const expressApp: Express = express();
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Translate route-layer events (kind: 'comment.created' / 'run.queued' / 'run.event' /
  // 'run.finished') into the WS-layer event shape (type: 'issue_updated' / 'run_started' /
  // 'run_event' / 'run_finished') and fan them out through the hub.
  const broadcastToWs = (msg: any) => {
    if (msg.kind === 'comment.created') {
      opts.hub.broadcast({ type: 'issue_updated', issueId: msg.issueId, status: 'in_progress' });
    } else if (msg.kind === 'run.queued') {
      opts.hub.broadcast({ type: 'run_started', runId: msg.runId, issueId: msg.issueId });
    } else if (msg.kind === 'run.event') {
      opts.hub.broadcast({
        type: 'run_event',
        runId: msg.run_id,
        stream: 'stdout',
        content: JSON.stringify(msg.event),
      });
    } else if (msg.kind === 'run.finished') {
      opts.hub.broadcast({
        type: 'run_finished',
        runId: msg.run_id,
        status: msg.exit_code === 0 ? 'done' : 'failed',
      });
    }
  };

  expressApp.use('/api/issues', issuesRouter(opts.db, opts.apiKey, broadcastToWs));
  expressApp.use('/api/comments', commentsRouter(opts.db, opts.apiKey));

  const httpServer = createServer(expressApp);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.httpPort, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const httpAddr = httpServer.address();
  const httpPort = typeof httpAddr === 'object' && httpAddr ? httpAddr.port : opts.httpPort;

  // WS server
  const ws = await createWsServer({ port: opts.wsPort, apiKey: opts.apiKey, hub: opts.hub });

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