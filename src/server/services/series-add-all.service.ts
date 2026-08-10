import type { FastifyBaseLogger } from 'fastify';
import {
  selectAddAllMembers,
  type AddAllMemberResult,
  type AddAllSeriesResponse,
} from '@shared/series-add-all.js';
import { serializeError } from '../utils/serialize-error.js';
import { addResolvedBook, type ResolvedAddDeps } from './book-add-resolved.js';
import { runImmediateSearch, type ImmediateSearchDeps } from './trigger-immediate-search.js';
import type { BookDetail, BookService } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { MetadataService } from './metadata.service.js';
import type { BookSeriesCardData, SeriesCardService } from './series-card.service.js';

export interface SeriesAddAllDeps {
  bookService: Pick<BookService, 'findDuplicate' | 'create'>;
  eventHistory: Pick<EventHistoryService, 'create'>;
  seriesCardService: Pick<SeriesCardService, 'getSeriesForBook'>;
  metadataService: Pick<MetadataService, 'resolveBook'>;
  search: ImmediateSearchDeps;
}

export type SeriesAddAllOutcome =
  | { outcome: 'ok'; response: AddAllSeriesResponse }
  | { outcome: 'in-flight' };

const ZERO_BATCH: AddAllSeriesResponse = { requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] };

/**
 * Adds every unowned major member of a book's series in one request. Each member is resolved
 * against the metadata provider before it is created, through the same pipeline an import list
 * runs, so its duplicate check sees the member's recording — not its title and author alone — and
 * the row lands with a cover instead of waiting on the enrichment cron (#2231).
 *
 * Identity is pinned, not adopted: the card's library pool is keyed on `books.seriesName`, so a row
 * created under the provider's series name would never appear on the card the operator was
 * looking at.
 */
export class SeriesAddAllService {
  /**
   * In-process and per-series only. Two requests for one series would otherwise both read the same
   * unowned snapshot and both create a row per member. A resolved row usually carries an ASIN the
   * unique index can fence, but an unresolved one carries none, so the guard is still the only
   * thing standing between an overlapping pair and duplicate rows. Not a distributed lock, which
   * the single-process design permits.
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
    // permits one at a time. Each member also resolves inline, so the request blocks for the whole
    // batch — measured against the live library that is ~30-35 lookups plus the metadata service's
    // 200ms throttle in the worst case, which the control's pending state already accounts for.
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
      const result = await addResolvedBook(this.addDeps(), {
        item: {
          title,
          // Undefined, never null or '': an authorless member must reach the resolver's stricter
          // title-only validation arm rather than search for an empty author.
          author: card.seriesAuthor ?? undefined,
          seriesName: card.name,
          seriesPosition: position,
        },
        identity: 'pin',
        provenance: { source: 'manual', reason: { seriesName: card.name } },
      }, log);

      if (result.outcome === 'created') {
        created.push(result.book);
        return { title, position, disposition: 'created', bookId: result.book.id };
      }
      if (result.outcome === 'owned-race' || result.outcome === 'same-recording') {
        return { title, position, disposition: 'owned', bookId: result.existingBookId };
      }
      // The pipeline awaits the hold's event before returning, so a rejection reaches the catch
      // below and reports failed rather than a hold with no durable artifact.
      return { title, position, disposition: 'held', bookId: result.existingBookId };
    } catch (error: unknown) {
      log.warn({ series: card.name, title, position, error: serializeError(error) }, 'Add All: member failed');
      return { title, position, disposition: 'failed', bookId: null };
    }
  }

  private addDeps(): ResolvedAddDeps {
    return {
      bookService: this.deps.bookService,
      recordEvent: (event) => this.deps.eventHistory.create(event),
      resolver: this.deps.metadataService,
    };
  }

  /** Detached but serial: N concurrent search-and-grab pipelines would hammer the operator's indexers. */
  private async runSearchChain(created: readonly BookDetail[], log: FastifyBaseLogger): Promise<void> {
    for (const book of created) {
      await runImmediateSearch(book, this.deps.search, log);
    }
  }
}
