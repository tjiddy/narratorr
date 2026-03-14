import { eq, desc, like, and, lt, count as countFn } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { bookEvents, downloads } from '../../db/schema.js';
import { type BlacklistService } from './blacklist.service.js';
import { type BookService } from './book.service.js';
import { actionableEventTypes, type EventType, type EventSource } from '../../shared/schemas/event-history.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';

type BookEventRow = typeof bookEvents.$inferSelect;

export interface CreateEventInput {
  bookId: number;
  bookTitle: string;
  authorName?: string | null;
  downloadId?: number | null;
  eventType: EventType;
  source: EventSource;
  reason?: Record<string, unknown> | null;
}

export class EventHistoryService {
  private retrySearchDeps?: RetrySearchDeps;

  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private blacklistService: BlacklistService,
    private bookService: BookService,
  ) {}

  /** Set retry search dependencies (called after service graph construction). */
  setRetrySearchDeps(deps: RetrySearchDeps): void {
    this.retrySearchDeps = deps;
  }

  async create(input: CreateEventInput): Promise<BookEventRow> {
    const result = await this.db.insert(bookEvents).values({
      bookId: input.bookId,
      bookTitle: input.bookTitle,
      authorName: input.authorName ?? null,
      downloadId: input.downloadId ?? null,
      eventType: input.eventType,
      source: input.source,
      reason: input.reason ?? null,
    }).returning();

    this.log.info({ bookId: input.bookId, eventType: input.eventType, bookTitle: input.bookTitle }, 'Event recorded');
    return result[0];
  }

  async getAll(
    filters?: { eventType?: string; search?: string },
    pagination?: { limit?: number; offset?: number },
  ): Promise<{ data: BookEventRow[]; total: number }> {
    const conditions = [];

    if (filters?.eventType) {
      conditions.push(eq(bookEvents.eventType, filters.eventType as EventType));
    }

    if (filters?.search) {
      conditions.push(like(bookEvents.bookTitle, `%${filters.search}%`));
    }

    const where = conditions.length > 0
      ? conditions.length === 1 ? conditions[0] : and(...conditions)
      : undefined;

    // Get total count (with filters, before pagination)
    const [{ value: total }] = await this.db
      .select({ value: countFn() })
      .from(bookEvents)
      .where(where);

    // Get data with optional pagination
    let query = this.db
      .select()
      .from(bookEvents)
      .where(where)
      .orderBy(desc(bookEvents.createdAt), desc(bookEvents.id));

    if (pagination?.limit !== undefined) {
      query = query.limit(pagination.limit) as typeof query;
    }
    if (pagination?.offset !== undefined) {
      query = query.offset(pagination.offset) as typeof query;
    }

    const data = await query;
    return { data, total };
  }

  async getByBookId(bookId: number): Promise<BookEventRow[]> {
    return this.db
      .select()
      .from(bookEvents)
      .where(eq(bookEvents.bookId, bookId))
      .orderBy(desc(bookEvents.createdAt));
  }

  async getById(id: number): Promise<BookEventRow | null> {
    const results = await this.db
      .select()
      .from(bookEvents)
      .where(eq(bookEvents.id, id))
      .limit(1);
    return results[0] || null;
  }

  async pruneOlderThan(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const deleted = await this.db
      .delete(bookEvents)
      .where(lt(bookEvents.createdAt, cutoff))
      .returning();
    return deleted.length;
  }

  async markFailed(eventId: number): Promise<{ success: true }> {
    const event = await this.getById(eventId);
    if (!event) {
      throw new Error('Event not found');
    }

    if (!actionableEventTypes.includes(event.eventType as EventType)) {
      throw new Error(`Event type '${event.eventType}' does not support mark-as-failed`);
    }

    if (!event.downloadId) {
      throw new Error('Event has no associated download');
    }

    // Look up download for infoHash
    const downloadRows = await this.db
      .select()
      .from(downloads)
      .where(eq(downloads.id, event.downloadId))
      .limit(1);

    const download = downloadRows[0];
    if (!download) {
      throw new Error('Associated download not found');
    }

    // Blacklist the release if infoHash present; skip for Usenet (no infoHash)
    if (download.infoHash) {
      await this.blacklistService.create({
        infoHash: download.infoHash,
        title: download.title,
        bookId: event.bookId ?? undefined,
        reason: 'bad_quality',
      });
    } else {
      this.log.debug({ downloadId: download.id }, 'Skipping blacklist — no infoHash (Usenet download)');
    }

    // Revert book to wanted status
    if (event.bookId) {
      await this.bookService.updateStatus(event.bookId, 'wanted');
    }

    this.log.info({ eventId, downloadId: event.downloadId, bookId: event.bookId }, 'Event marked as failed');

    // Trigger book-scoped retry search (fire-and-forget) — does NOT reset global retry budget
    if (event.bookId && this.retrySearchDeps) {
      retrySearch(event.bookId, this.retrySearchDeps)
        .catch((err) => this.log.warn(err, 'Mark-as-failed retry search failed'));
    }

    return { success: true };
  }
}
