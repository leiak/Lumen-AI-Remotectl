import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3100),
  host: process.env.HOST ?? '100.100.100.100', // Tailscale IP, override via env
  dbPath: process.env.DB_PATH ?? path.resolve(__dirname, '../data/remotectl.db'),
  dataDir: path.resolve(__dirname, '../data'),
  workspaceDefault: process.env.WORKSPACE_DEFAULT ?? path.join(os.homedir(), 'code'),
  adapterBinary: process.env.CLAUDE_BINARY ?? 'claude',
  adapterArgs: ['--dangerously-skip-permissions', '--output-format', 'stream-json'],
} as const;
