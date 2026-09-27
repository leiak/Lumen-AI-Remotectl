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
  expressApp.use('/api/issues', issuesRouter(opts.db, opts.apiKey));
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