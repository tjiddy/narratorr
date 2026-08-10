import type { FastifyBaseLogger } from 'fastify';
import {
  selectAddAllMembers,
  type AddAllMemberResult,
  type AddAllSeriesResponse,
} from '@shared/series-add-all.js';
import { serializeError } from '../utils/serialize-error.js';
import { addBookThroughLadder, type AddBookLadderDeps } from './book-add-ladder.js';
import { runImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import type { RecordingReviewReason } from '@core/utils/recording-identity.js';
import type { BookDetail, BookService } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { BookSeriesCardData, SeriesCardService } from './series-card.service.js';

export interface SeriesAddAllDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create' | 'getById'>;
  eventHistory: Pick<EventHistoryService, 'create'>;
  seriesCardService: Pick<SeriesCardService, 'getSeriesForBook'>;
  search: ImmediateSearchDeps;
}

export type SeriesAddAllOutcome =
  | { outcome: 'ok'; response: AddAllSeriesResponse }
  | { outcome: 'in-flight' };

const ZERO_BATCH: AddAllSeriesResponse = { requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] };

/**
 * Adds every unowned major member of a book's series in one request. Rows are seeded from the
 * Hardcover card with no ASIN, so the existing enrichment job resolves their metadata later; the
 * batch never calls the metadata provider itself.
 */
export class SeriesAddAllService {
  /**
   * In-process and per-series only. Two requests for one series would otherwise both read the same
   * unowned snapshot and both create a row per member — the created rows carry no ASIN, so the
   * unique index cannot fence them. Not a distributed lock, which the single-process design permits.
   */
  private readonly inFlight = new Set<number>();

  constructor(private readonly deps: SeriesAddAllDeps) {}

  async addAll(
    bookId: number,
    options: { searchImmediately: boolean },
    log: FastifyBaseLogger,
  ): Promise<SeriesAddAllOutcome> {
    const identity = await this.deps.seriesCardService.getSeriesForBook(bookId);
    if (!identity) return { outcome: 'ok', response: { ...ZERO_BATCH } };
    if (identity.id === null) return { outcome: 'ok', response: this.libraryOnlyBatch(identity, bookId, log) };

    const seriesId = identity.id;
    if (this.inFlight.has(seriesId)) return { outcome: 'in-flight' };
    this.inFlight.add(seriesId);

    let created: BookDetail[];
    let response: AddAllSeriesResponse;
    try {
      // Re-read inside the guard: a batch that finished between the identity read and admission
      // would otherwise leave this caller working from a snapshot that predates its rows.
      const card = (await this.deps.seriesCardService.getSeriesForBook(bookId)) ?? identity;
      ({ created, response } = await this.runBatch(card, log));
    } finally {
      // Released before the searches so a long indexer run cannot hold the series.
      this.inFlight.delete(seriesId);
    }

    if (options.searchImmediately && created.length > 0) {
      void this.runSearchChain(created, log);
    }
    return { outcome: 'ok', response };
  }

  /**
   * A null series id means no Hardcover key or a failed resolution, and such a card lists only
   * owned library books — so there is nothing to add and no key a guard could use.
   */
  private libraryOnlyBatch(card: BookSeriesCardData, bookId: number, log: FastifyBaseLogger): AddAllSeriesResponse {
    const selectable = selectAddAllMembers(card.members).length;
    if (selectable > 0) {
      log.warn({ bookId, series: card.name, selectable }, 'Add All: a library-only series card offered unowned members; skipping the batch');
    }
    return { ...ZERO_BATCH };
  }

  private async runBatch(
    card: BookSeriesCardData,
    log: FastifyBaseLogger,
  ): Promise<{ created: BookDetail[]; response: AddAllSeriesResponse }> {
    const created: BookDetail[] = [];
    const members: AddAllMemberResult[] = [];
    // Sequential by contract: BookService.create opens a transaction and the libSQL connection
    // permits one at a time.
    for (const selected of selectAddAllMembers(card.members)) {
      members.push(await this.addMember(card, selected.title.trim(), selected.position as number, created, log));
    }

    const count = (disposition: AddAllMemberResult['disposition']) =>
      members.filter((m) => m.disposition === disposition).length;
    return {
      created,
      response: {
        requested: members.length,
        created: count('created'),
        owned: count('owned'),
        held: count('held'),
        failed: count('failed'),
        members,
      },
    };
  }

  private async addMember(
    card: BookSeriesCardData,
    title: string,
    position: number,
    created: BookDetail[],
    log: FastifyBaseLogger,
  ): Promise<AddAllMemberResult> {
    try {
      const result = await addBookThroughLadder(this.ladderDeps(), {
        title,
        authors: card.seriesAuthor ? [{ name: card.seriesAuthor }] : [],
        seriesName: card.name,
        seriesPosition: position,
      }, log);

      if (result.outcome === 'created') {
        created.push(result.book);
        return { title, position, disposition: 'created', bookId: result.book.id };
      }
      if (result.outcome === 'owned-race') {
        return { title, position, disposition: 'owned', bookId: result.existingBookId };
      }
      if (result.verdict === 'same-recording') {
        return { title, position, disposition: 'owned', bookId: result.book.id };
      }
      // The event IS the durable artifact for a hold, so it must commit before the member is
      // reported held; a rejection falls to the catch below and reports failed instead.
      await this.recordReviewSkip(card, title, result.book.id, result.recordingReviewReason);
      return { title, position, disposition: 'held', bookId: result.book.id };
    } catch (error: unknown) {
      log.warn({ series: card.name, title, position, error: serializeError(error) }, 'Add All: member failed');
      return { title, position, disposition: 'failed', bookId: null };
    }
  }

  private ladderDeps(): AddBookLadderDeps {
    return { bookService: this.deps.bookService, eventHistory: this.deps.eventHistory };
  }

  /** Mirrors the import-list precedent: the hold lives on the incumbent's history, under Needs Review. */
  private async recordReviewSkip(
    card: BookSeriesCardData,
    title: string,
    existingBookId: number,
    recordingReviewReason: RecordingReviewReason | undefined,
  ): Promise<void> {
    await this.deps.eventHistory.create({
      bookId: existingBookId,
      bookTitle: title,
      authorName: card.seriesAuthor,
      eventType: 'recording_review_skipped',
      source: 'manual',
      reason: { seriesName: card.name, existingBookId, ...(recordingReviewReason && { recordingReviewReason }) },
    });
  }

  /** Detached but serial: N concurrent search-and-grab pipelines would hammer the operator's indexers. */
  private async runSearchChain(created: readonly BookDetail[], log: FastifyBaseLogger): Promise<void> {
    for (const book of created) {
      await runImmediateSearch(book, this.deps.search, log);
    }
  }
}
