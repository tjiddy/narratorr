import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { runSerializedTransaction } from './serial-transactions.js';

export function createDb(dbPath: string) {
  const client = createClient({
    url: `file:${dbPath}`,
  });
  const db = drizzle(client, { schema });

  // Shadow at the connection boundary so no db.transaction caller can bypass serialization.
  const openTransaction = db.transaction.bind(db);
  // bind erases the generic signature; keep the restoring cast local.
  db.transaction = ((...args: Parameters<typeof openTransaction>) =>
    runSerializedTransaction(db, () => openTransaction(...args))) as typeof db.transaction;

  return db;
}

export type Db = ReturnType<typeof createDb>;

export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export type DbOrTx = Db | Transaction;
