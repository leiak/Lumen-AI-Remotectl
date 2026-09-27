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
const DEFAULT_HTTP_PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_WS_PORT = Number(process.env.WS_PORT ?? 8788);

export async function startCommand() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = createDb(dbPath) as Db;
  await migrate(db);

  // Read or create apiKey
  let apiKey: string;
  const existing = await db.select().from(settings).where(eq(settings.key, 'apiKey')).get();
  if (existing) {
    apiKey = existing.value;
  } else {
    apiKey = generateApiKey();
    await db.insert(settings).values({ key: 'apiKey', value: apiKey }).run();
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
  console.log(`  Token: ${apiKey}`);

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await app.shutdown();
    process.exit(0);
  });
}