import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { runSerializedTransaction } from './serial-transactions.js';

/**
 * No statement-serialization lane here, and adding one would not help: statement execution in the
 * pinned binding is synchronous, so two statements are never inside it at once and a JS-level lane
 * would reorder scheduling while removing zero native overlap. That is measured, not read off the
 * driver source — `statement-execution-model.integration.test.ts` pins it and reds if a future driver
 * makes execution genuinely asynchronous (#2595, docs/crash-forensics.md §7).
 *
 * `@libsql/client` must stay >= 0.18.0. 0.17.x hands the live native connection to every
 * `client.transaction()` and lazily opens another, leaving the old one to GC finalization; libsql
 * 0.5.29 segfaults when a statement is finalized before the connection it was prepared on. That was
 * the production SIGSEGV. 0.18.0 pools connections and never drops them (docs/crash-forensics.md §8).
 */
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
