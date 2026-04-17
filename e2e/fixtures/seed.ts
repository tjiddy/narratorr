import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { runMigrations } from '../../src/db/migrate.js';
import { authors, bookAuthors, books, downloadClients, indexers, settings } from '../../src/db/schema.js';

/**
 * Pre-boot Drizzle seed for the E2E harness. Runs migrations against the
 * per-run DB file, then inserts the rows the spec test depends on:
 *
 *   - `indexers`        — MAM pointing at the fake MAM server
 *   - `download_clients` — qBittorrent pointing at the fake qBit server
 *   - `authors` + `books` — the seeded book the test opens on /library
 *
 * Runs *before* webServer boots so the app finds the rows in place at startup.
 * Narratorr's own `migrate()` on boot is idempotent via Drizzle's journal, so
 * re-running here is safe.
 */

export interface SeedE2ERunOptions {
  dbPath: string;
  /** Base URL the MAM fake listens on. */
  mamUrl: string;
  /** qBit fake host (no protocol/port — matches qbittorrentSettingsSchema). */
  qbitHost: string;
  /** qBit fake port. */
  qbitPort: number;
  /**
   * Absolute path Narratorr should use as the library root. Written to
   * `settings.library.path` so `importDownload` sees a real directory when it
   * calls `statfs(libraryPath)` during the disk-space gate. Narratorr's
   * LIBRARY_PATH env var is decorative — nothing reads it at runtime.
   */
  libraryPath: string;
  /** mam_id cookie the fake accepts. */
  mamId?: string;
  /** qBit fake credentials. */
  qbitUsername?: string;
  qbitPassword?: string;
}

export interface SeededRowIds {
  indexerId: number;
  downloadClientId: number;
  authorId: number;
  bookId: number;
}

export const SEED_BOOK_TITLE = 'E2E Test Book';
export const SEED_AUTHOR_NAME = 'E2E Test Author';
export const SEED_SEARCH_QUERY = 'e2e test book';

export async function seedE2ERun(options: SeedE2ERunOptions): Promise<SeededRowIds> {
  await runMigrations(options.dbPath);

  const client = createClient({ url: `file:${options.dbPath}` });
  const db = drizzle(client);

  try {
    return await db.transaction(async (tx) => {
      // ── Indexer ──────────────────────────────────────────────────────────
      const [indexerRow] = await tx
        .insert(indexers)
        .values({
          name: 'E2E MAM',
          type: 'myanonamouse',
          enabled: true,
          priority: 50,
          settings: {
            baseUrl: options.mamUrl,
            mamId: options.mamId ?? 'test-mam-id',
            searchLanguages: [1], // English
            searchType: 'all',
          },
        })
        .returning({ id: indexers.id });

      // ── Download client ──────────────────────────────────────────────────
      // NOTE: qbittorrentSettingsSchema is .strict() — do NOT add a `savePath` field.
      // The fake qBit defaults its save_path to its constructor-configured downloadsPath.
      const [clientRow] = await tx
        .insert(downloadClients)
        .values({
          name: 'E2E qBit',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: {
            host: options.qbitHost,
            port: options.qbitPort,
            username: options.qbitUsername ?? 'admin',
            password: options.qbitPassword ?? 'adminadmin',
            useSsl: false,
          },
        })
        .returning({ id: downloadClients.id });

      // ── Author + book ────────────────────────────────────────────────────
      const authorSlug = SEED_AUTHOR_NAME
        .toLowerCase()
        .replace(/[^\w]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const [authorRow] = await tx
        .insert(authors)
        .values({
          name: SEED_AUTHOR_NAME,
          slug: authorSlug,
        })
        .returning({ id: authors.id });

      const [bookRow] = await tx
        .insert(books)
        .values({
          title: SEED_BOOK_TITLE,
          status: 'wanted',
          enrichmentStatus: 'pending',
        })
        .returning({ id: books.id });

      await tx.insert(bookAuthors).values({
        bookId: bookRow.id,
        authorId: authorRow.id,
        position: 0,
      });

      // Pre-dismiss the WelcomeModal so it doesn't intercept clicks on /library.
      // settings table is key/value JSON — `general` holds the flag.
      await tx.insert(settings).values({
        key: 'general',
        value: { logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: true },
      });

      // Library settings must point at the per-run temp dir. Narratorr's
      // LIBRARY_PATH env var is decorative — only settings.library.path is
      // read at runtime (verified: grep `config.libraryPath` has no non-test
      // consumers). Without this, imports hit the registry default `/audiobooks`
      // which doesn't exist on the test host → statfs ENOENT → import fails.
      await tx.insert(settings).values({
        key: 'library',
        value: {
          path: options.libraryPath,
          folderFormat: '{author}/{title}',
          fileFormat: '{author} - {title}',
          namingSeparator: 'space',
          namingCase: 'default',
        },
      });

      // Disable the disk-space gate. Temp runners may report low free space,
      // and the E2E fixture is sub-5KB — the gate's sole purpose is protecting
      // real-user libraries, not validating our copy path.
      await tx.insert(settings).values({
        key: 'import',
        value: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 0, redownloadFailed: true },
      });

      return {
        indexerId: indexerRow.id,
        downloadClientId: clientRow.id,
        authorId: authorRow.id,
        bookId: bookRow.id,
      };
    });
  } finally {
    client.close();
  }
}
