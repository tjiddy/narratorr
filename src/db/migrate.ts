import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import { getErrorMessage } from '@shared/error-message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(dbPath: string) {
  const client = createClient({
    url: `file:${dbPath}`,
  });
  const db = drizzle(client);

  // Both src/db and dist/server resolve ../../drizzle to the repository migrations.
  try {
    await migrate(db, {
      migrationsFolder: path.join(__dirname, '../../drizzle'),
    });
  } finally {
    // Windows keeps the DB file locked until the client closes.
    client.close();
  }

  return db;
}

/**
 * `console.error(msg, err)` hands the object to `util.inspect`, which prints own enumerable
 * properties — so a `DrizzleQueryError` would print its full `query` and `params`. Reachable in
 * normal operation: `pnpm db:migrate` against a schema/constraint mismatch (#2604 AC7). A CLI
 * operator wants readable text, not a JSON log record, so this renders rather than serializes.
 */
export function reportMigrationFailure(err: unknown): void {
  console.error('Migration failed:', getErrorMessage(err));
}

// tsup inlines this module; never let its CLI process.exit path run in the server bundle.
const isBundled = !import.meta.url.includes('/src/');
if (!isBundled && process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DATABASE_PATH || './narratorr.db';
  console.log(`Running migrations on ${dbPath}...`);
  runMigrations(dbPath)
    .then(() => {
      console.log('Migrations complete.');
      process.exit(0);
    })
    .catch((err: unknown) => {
      reportMigrationFailure(err);
      process.exit(1);
    });
}
