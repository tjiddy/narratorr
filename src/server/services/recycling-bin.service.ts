import { join, dirname } from 'node:path';
import { mkdir, rename, cp, rm, access } from 'node:fs/promises';
import { eq, lte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { recyclingBin, books } from '../../db/schema.js';
import type { SettingsService } from './settings.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';

type RecyclingBinRow = typeof recyclingBin.$inferSelect;
type NewRecyclingBinRow = typeof recyclingBin.$inferInsert;

export class RecyclingBinError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'CONFLICT' | 'FILESYSTEM',
  ) {
    super(message);
    this.name = 'RecyclingBinError';
  }
}

export class RecyclingBinService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private configPath: string,
    private settingsService: SettingsService,
    private bookService?: BookService,
  ) {}

  /** Move a book's files to the recycling bin and create a DB record. */
  async moveToRecycleBin(book: BookWithAuthor, bookPath: string | null): Promise<RecyclingBinRow> {
    const recyclePath = join(this.configPath, 'recycle', String(book.id));

    // Move files if they exist on disk
    if (bookPath) {
      try {
        await access(bookPath);
        await this.moveFiles(bookPath, recyclePath);
      } catch (error: unknown) {
        // If files don't exist (ENOENT), continue — still create recycling record for metadata recovery
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        this.log.info({ bookId: book.id, path: bookPath }, 'Book files not found on disk — creating recycling record for metadata recovery');
      }
    }

    const record: NewRecyclingBinRow = {
      bookId: book.id,
      title: book.title,
      authorName: book.authors?.length ? book.authors.map(a => a.name) : null,
      authorAsin: book.authors?.[0]?.asin ?? null,
      narrator: book.narrators?.length ? book.narrators.map(n => n.name) : null,
      description: book.description,
      coverUrl: book.coverUrl,
      asin: book.asin,
      isbn: book.isbn,
      seriesName: book.seriesName,
      seriesPosition: book.seriesPosition,
      duration: book.duration,
      publishedDate: book.publishedDate,
      genres: book.genres,
      monitorForUpgrades: book.monitorForUpgrades,
      originalPath: bookPath ?? '',
      recyclePath,
    };

    const [inserted] = await this.db.insert(recyclingBin).values(record).returning();
    this.log.info({ id: inserted.id, bookId: book.id, recyclePath }, 'Book moved to recycling bin');
    return inserted;
  }

  /** Restore a recycling bin entry — move files back and re-create the book in DB. */
  // eslint-disable-next-line complexity -- restore pipeline: path conflict check, file move, DB insert, author/narrator sync
  async restore(entryId: number): Promise<{ bookId: number }> {
    const entry = await this.getById(entryId);
    if (!entry) {
      throw new RecyclingBinError('Recycling bin entry not found', 'NOT_FOUND');
    }

    // Check if original path is occupied by another book
    if (entry.originalPath) {
      const existing = await this.db
        .select({ id: books.id, title: books.title })
        .from(books)
        .where(eq(books.path, entry.originalPath))
        .limit(1);
      if (existing.length > 0) {
        throw new RecyclingBinError(
          `Original path is occupied by "${existing[0].title}" (book #${existing[0].id})`,
          'CONFLICT',
        );
      }
    }

    // Move files back if recycle directory exists
    if (entry.recyclePath && entry.originalPath) {
      try {
        await access(entry.recyclePath);
        await this.moveFiles(entry.recyclePath, entry.originalPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new RecyclingBinError('Recycled files not found on disk', 'FILESYSTEM');
        }
        throw error;
      }
    }

    // Wrap all DB mutations in a transaction — filesystem move already happened above
    const hasPath = Boolean(entry.originalPath);
    const newBookId = await this.db.transaction(async (tx) => {
      const [newBook] = await tx.insert(books).values({
        title: entry.title,
        description: entry.description,
        coverUrl: entry.coverUrl,
        asin: entry.asin,
        isbn: entry.isbn,
        seriesName: entry.seriesName,
        seriesPosition: entry.seriesPosition,
        duration: entry.duration,
        publishedDate: entry.publishedDate,
        genres: entry.genres,
        monitorForUpgrades: entry.monitorForUpgrades,
        status: hasPath ? 'imported' : 'wanted',
        enrichmentStatus: 'pending',
        path: hasPath ? entry.originalPath : null,
      }).returning();

      // Restore author junction rows from snapshot (authorName is a JSON string array)
      if (entry.authorName?.length && this.bookService) {
        const authorList = entry.authorName.map((name, i) => ({
          name,
          asin: i === 0 ? (entry.authorAsin ?? undefined) : undefined,
        }));
        await this.bookService.syncAuthors(tx, newBook.id, authorList);
      }

      // Restore narrator junction rows from snapshot (narrator is a JSON string array)
      if (entry.narrator?.length && this.bookService) {
        await this.bookService.syncNarrators(tx, newBook.id, entry.narrator);
      }

      // Remove recycling bin record
      await tx.delete(recyclingBin).where(eq(recyclingBin.id, entryId));

      return newBook.id;
    });

    this.log.info({ entryId, newBookId }, 'Book restored from recycling bin');
    return { bookId: newBookId };
  }

  /** Permanently delete a single recycling bin entry. */
  async purge(entryId: number): Promise<boolean> {
    const entry = await this.getById(entryId);
    if (!entry) return false;

    // Try to remove files from disk (ignore if already gone)
    if (entry.recyclePath) {
      try {
        await rm(entry.recyclePath, { recursive: true, force: true });
      } catch {
        this.log.warn({ entryId, path: entry.recyclePath }, 'Failed to remove recycle files from disk');
      }
    }

    await this.db.delete(recyclingBin).where(eq(recyclingBin.id, entryId));
    this.log.info({ entryId }, 'Recycling bin entry permanently deleted');
    return true;
  }

  /** Permanently delete all recycling bin entries. Returns count of purged items. */
  async purgeAll(): Promise<{ purged: number; failed: number }> {
    const entries = await this.list();
    let purged = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        if (entry.recyclePath) {
          await rm(entry.recyclePath, { recursive: true, force: true });
        }
        await this.db.delete(recyclingBin).where(eq(recyclingBin.id, entry.id));
        purged++;
      } catch (error: unknown) {
        failed++;
        this.log.error({ entryId: entry.id, error }, 'Failed to purge recycling bin entry');
      }
    }

    this.log.info({ purged, failed }, 'Recycling bin emptied');
    return { purged, failed };
  }

  /** Delete entries older than the configured retention period. */
  async purgeExpired(): Promise<{ purged: number; failed: number }> {
    const generalSettings = await this.settingsService.get('general');
    const retentionDays = generalSettings.recycleRetentionDays ?? 30;

    if (retentionDays === 0) {
      this.log.debug('Recycle cleanup disabled (retention = 0)');
      return { purged: 0, failed: 0 };
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const expired = await this.db
      .select()
      .from(recyclingBin)
      .where(lte(recyclingBin.deletedAt, cutoff));

    let purged = 0;
    let failed = 0;

    for (const entry of expired) {
      try {
        if (entry.recyclePath) {
          await rm(entry.recyclePath, { recursive: true, force: true });
        }
        await this.db.delete(recyclingBin).where(eq(recyclingBin.id, entry.id));
        purged++;
      } catch (error: unknown) {
        failed++;
        this.log.error({ entryId: entry.id, error }, 'Failed to purge expired recycling bin entry');
      }
    }

    if (purged > 0 || failed > 0) {
      this.log.info({ purged, failed, retentionDays }, 'Recycling bin cleanup completed');
    }

    return { purged, failed };
  }

  /** List all recycling bin entries. */
  async list(): Promise<RecyclingBinRow[]> {
    return this.db.select().from(recyclingBin).orderBy(recyclingBin.deletedAt);
  }

  /** Get a single recycling bin entry by ID. */
  async getById(id: number): Promise<RecyclingBinRow | undefined> {
    const [entry] = await this.db.select().from(recyclingBin).where(eq(recyclingBin.id, id)).limit(1);
    return entry;
  }

  /** Move files between paths with EXDEV (cross-filesystem) fallback. */
  private async moveFiles(fromPath: string, toPath: string): Promise<void> {
    await mkdir(dirname(toPath), { recursive: true });

    try {
      await rename(fromPath, toPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        this.log.info({ fromPath, toPath }, 'Cross-volume move — falling back to copy+delete');
        await cp(fromPath, toPath, { recursive: true });
        await rm(fromPath, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
  }
}
