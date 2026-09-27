import { createDb } from '@remotectl/server/db/client';
import { migrate } from '@remotectl/server/db/migrate';
import { settings } from '@remotectl/server/db/schema';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.remotectl', 'server.db');

export async function tokenCommand() {
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run \`remotectl start\` first.`);
    process.exit(1);
  }
  const db = createDb(dbPath);
  await migrate(db);
  const row = await db.select().from(settings).where(eq(settings.key, 'apiKey')).get();
  if (!row) {
    console.error('No apiKey set. Run `remotectl start` first.');
    process.exit(1);
  }
  console.log(row.value);
}