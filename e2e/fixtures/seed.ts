import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { runMigrations } from '../../src/db/migrate.js';
import { authors, bookAuthors, books, downloadClients, indexers, settings } from '../../src/db/schema.js';
import { generatePublicId } from '../../src/server/utils/public-id.js';

/** Migrates and seeds each run before server boot with fake MAM/qBit and wanted-book rows. */

export interface SeedE2ERunOptions {
  dbPath: string;
  mamUrl: string;
  /** Host only, matching `qbittorrentSettingsSchema`; no protocol or port. */
  qbitHost: string;
  qbitPort: number;
  /** Real directory stored in `settings.library.path`; the `LIBRARY_PATH` env variable is unused. */
  libraryPath: string;
  mamId?: string;
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
            searchLanguages: [1], // MAM's numeric code for English
            searchType: 'all',
          },
        })
        .returning({ id: indexers.id });

      // The strict qBit schema forbids `savePath`; the fake supplies its configured default.
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

      const authorSlug = SEED_AUTHOR_NAME
        .toLowerCase()
        .replace(/[^\w]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const [authorRow] = await tx
        .insert(authors)
        .values({
          publicId: generatePublicId('au'),
          name: SEED_AUTHOR_NAME,
          slug: authorSlug,
        })
        .returning({ id: authors.id });

      const [bookRow] = await tx
        .insert(books)
        .values({
          publicId: generatePublicId('bk'),
          title: SEED_BOOK_TITLE,
          status: 'wanted',
          enrichmentStatus: 'pending',
        })
        .returning({ id: books.id });

      await tx.insert(bookAuthors).values({
        bookId: bookRow!.id,
        authorId: authorRow!.id,
        position: 0,
      });

      // Prevent WelcomeModal from intercepting library-page clicks.
      await tx.insert(settings).values({
        key: 'general',
        value: { logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: true },
      });

      // Only `settings.library.path` is read at runtime; `LIBRARY_PATH` is decorative.
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

      // Disable real-library free-space protection for the tiny fixture.
      await tx.insert(settings).values({
        key: 'import',
        value: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 0, redownloadFailed: true },
      });

      return {
        indexerId: indexerRow!.id,
        downloadClientId: clientRow!.id,
        authorId: authorRow!.id,
        bookId: bookRow!.id,
      };
    });
  } finally {
    client.close();
  }
}
