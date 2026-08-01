import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { runSerializedTransaction } from './serial-transactions.js';

export function createDb(dbPath: string) {
  const client = createClient({
    url: `file:${dbPath}`,
  });
  const db = drizzle(client, { schema });

  // Every transaction on this connection is serialized here, at the connection itself, rather
  // than by each caller opting into a helper — see `serial-transactions.ts` for why. Shadowing
  // the instance method keeps `db.transaction(fn)` the one and only entry point, so all
  // twenty-two existing call sites are covered without touching any of them, and a new one
  // cannot be written that bypasses it.
  const openTransaction = db.transaction.bind(db);
  // The cast restores the generic signature the bound reference erased. It is confined to this
  // assignment and reaches no exported type — `Db` below is still exactly drizzle's.
  db.transaction = ((...args: Parameters<typeof openTransaction>) =>
    runSerializedTransaction(db, () => openTransaction(...args))) as typeof db.transaction;

  return db;
}

export type Db = ReturnType<typeof createDb>;

/** Transaction-scoped DB handle passed to db.transaction() callbacks. */
export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Accepts either the full Db instance or a transaction-scoped handle. */
export type DbOrTx = Db | Transaction;
