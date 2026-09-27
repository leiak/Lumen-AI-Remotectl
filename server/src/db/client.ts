import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

export function createDb(dbPath: string) {
  const client: Client = createClient({ url: `file:${dbPath}` });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
