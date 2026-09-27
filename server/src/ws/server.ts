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
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = auth.slice('Bearer '.length);
    const a = Buffer.from(token);
    const b = Buffer.from(opts.apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      opts.hub.attach(ws);
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port, '127.0.0.1', resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
}