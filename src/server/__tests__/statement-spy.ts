import type { Db } from '@db/index.js';

/** `scope` is 'client' for statements on the connection, or `tx<n>` for the nth transaction opened while spying. */
export interface CapturedStatement { scope: string; sql: string; args: unknown }

export interface StatementSpy {
  executed: CapturedStatement[];
  /** One entry per transaction opened while spying, in open order; length is the transaction count. */
  transactions: string[];
  restore: () => void;
}

/**
 * Captures SQL, args and scope. Drizzle routes a query on a `tx` handle through the libsql
 * transaction object rather than the client (`libsql/session.js`:
 * `this.tx ? this.tx.execute(stmt) : this.client.execute(stmt)`), so patching `client.execute` alone
 * captures statements inside a transaction ZERO times. Wrapping the handle `client.transaction()`
 * returns is the only observation point that sees them (#2194 T0).
 *
 * The scope tag separates an in-transaction read from a post-commit render read that would otherwise
 * inflate the total, and the transaction count catches work that migrates OUT of a transaction,
 * which no per-statement count would notice.
 */
export function spyStatements(db: Db): StatementSpy {
  type Executor = { execute: (...a: unknown[]) => unknown };
  const client = db.$client as unknown as Executor & { transaction: (...a: unknown[]) => Promise<Executor> };
  const originalExecute = client.execute.bind(client);
  const originalTransaction = client.transaction.bind(client);
  const executed: CapturedStatement[] = [];
  const transactions: string[] = [];

  function instrument(target: Executor, scope: string): void {
    const inner = target.execute.bind(target);
    // Instance assignment shadows Sqlite3Transaction.prototype.execute; the prototype is untouched.
    target.execute = ((stmt: unknown, ...rest: unknown[]) => {
      const text = typeof stmt === 'string' ? stmt : (stmt as { sql?: string })?.sql ?? '';
      executed.push({ scope, sql: text, args: typeof stmt === 'string' ? [] : (stmt as { args?: unknown })?.args ?? [] });
      return inner(stmt as never, ...(rest as never[]));
    }) as typeof target.execute;
  }

  instrument(client, 'client');
  client.transaction = (async (...args: unknown[]) => {
    const tx = await originalTransaction(...(args as never[]));
    const scope = `tx${transactions.length + 1}`;
    transactions.push(scope);
    instrument(tx, scope);
    return tx;
  }) as typeof client.transaction;

  return {
    executed,
    transactions,
    restore: () => {
      client.execute = originalExecute as typeof client.execute;
      client.transaction = originalTransaction as typeof client.transaction;
    },
  };
}

/** The library-pool projection, identified by its own columns rather than by statement position. */
export function poolStatements(executed: CapturedStatement[]): CapturedStatement[] {
  return executed.filter((s) => /from "books"/i.test(s.sql) && /"series_position"/.test(s.sql) && /"user_cleared_fields"/.test(s.sql));
}
