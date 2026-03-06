import { eq, desc, like, and } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { bookEvents, downloads } from '@narratorr/db/schema';
import { type BlacklistService } from './blacklist.service.js';
import { type BookService } from './book.service.js';
import { actionableEventTypes, type EventType, type EventSource } from '../../shared/schemas/event-history.js';

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
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private blacklistService: BlacklistService,
    private bookService: BookService,
  ) {}

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

  async getAll(filters?: { eventType?: string; search?: string }): Promise<BookEventRow[]> {
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

    return this.db
      .select()
      .from(bookEvents)
      .where(where)
      .orderBy(desc(bookEvents.createdAt));
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
    if (!download || !download.infoHash) {
      throw new Error('Associated download not found or has no info hash');
    }

    // Blacklist the release
    await this.blacklistService.create({
      infoHash: download.infoHash,
      title: download.title,
      bookId: event.bookId ?? undefined,
      reason: 'bad_quality',
    });

    // Revert book to wanted status
    if (event.bookId) {
      await this.bookService.updateStatus(event.bookId, 'wanted');
    }

    this.log.info({ eventId, downloadId: event.downloadId, bookId: event.bookId }, 'Event marked as failed');
    return { success: true };
  }
}
