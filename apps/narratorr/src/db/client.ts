import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

export function createDb(dbPath: string) {
  const client = createClient({
    url: `file:${dbPath}`,
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
