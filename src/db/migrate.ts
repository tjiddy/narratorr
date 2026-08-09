import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'path';
import { fileURLToPath } from 'url';

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
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
