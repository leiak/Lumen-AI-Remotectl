import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import path from 'node:path';
import * as schema from './schema.js';

function toLibsqlUrl(dbPath: string): string {
  if (dbPath.startsWith('file:')) return dbPath;
  const normalized = dbPath.replace(/\\/g, '/');
  // Absolute paths need `file:///` prefix (3 slashes), relative need `file:`
  return path.isAbsolute(dbPath) ? `file:///${normalized}` : `file:${normalized}`;
}

export function createDb(dbPath: string) {
  const client = createClient({ url: toLibsqlUrl(dbPath) });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
