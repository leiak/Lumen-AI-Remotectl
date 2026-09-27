import { createDb, type Db } from '@remotectl/server/db/client';
import { migrate } from '@remotectl/server/db/migrate';
import { settings } from '@remotectl/server/db/schema';
import { eq } from 'drizzle-orm';
import { generateApiKey } from '@remotectl/server/auth';
import { BroadcastHub } from '@remotectl/server/ws/broadcast';
import { createApp } from '@remotectl/server';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.remotectl');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'server.db');

// Parse an env-var port. Throws if the value is set but non-numeric, falls back
// silently when unset. This prevents `Number('garbage')` from silently yielding
// NaN and breaking createApp's listen() call.
function parsePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid ${name}="${raw}": must be an integer in 0..65535`);
  }
  return n;
}

const DEFAULT_HTTP_PORT = parsePort('PORT', 8787);
const DEFAULT_WS_PORT = parsePort('WS_PORT', 8788);

export async function startCommand() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  // Lock down the parent directory on POSIX (mode is silently ignored on
  // Windows where ACLs govern file access; not a concern for loopback-only v0.1).
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = createDb(dbPath) as Db;
  await migrate(db);

  // Lock down the DB file itself. No-op on Windows (ACLs); on POSIX prevents
  // other local users from reading the plaintext apiKey.
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // best-effort; not all FSes support chmod
  }

  // Read or create apiKey, tolerating the race where two `remotectl start`
  // invocations boot concurrently and both observe `existing === undefined`.
  let apiKey: string;
  let isFirstStart = false;
  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'apiKey'))
    .get();
  if (existing) {
    apiKey = existing.value;
  } else {
    apiKey = generateApiKey();
    await db
      .insert(settings)
      .values({ key: 'apiKey', value: apiKey })
      .onConflictDoNothing()
      .run();
    // Re-read in case a concurrent process won the race and inserted first.
    const after = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'apiKey'))
      .get();
    if (after && after.value !== apiKey) {
      apiKey = after.value;
    } else {
      isFirstStart = true;
    }
  }

  const hub = new BroadcastHub();
  const app = await createApp({
    db,
    apiKey,
    hub,
    httpPort: DEFAULT_HTTP_PORT,
    wsPort: DEFAULT_WS_PORT,
  });

  console.log(`remotectl server listening`);
  console.log(`  HTTP: http://127.0.0.1:${app.httpPort}`);
  console.log(`  WS:   ws://127.0.0.1:${app.wsPort}`);
  if (isFirstStart) {
    console.log(`  Token: ${apiKey}`);
  } else {
    console.log(`  Token: (unchanged, run \`remotectl token\` to view)`);
  }

  // Graceful shutdown for SIGINT (Ctrl+C) and SIGTERM (kill, systemd, etc.).
  // A stuck connection must not hang Ctrl+C forever — bail after 5s.
  const SHUTDOWN_TIMEOUT_MS = 5000;
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await Promise.race([
        app.shutdown(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('shutdown timeout')),
            SHUTDOWN_TIMEOUT_MS,
          ),
        ),
      ]);
      process.exit(0);
    } catch (err) {
      console.error('Shutdown failed:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}