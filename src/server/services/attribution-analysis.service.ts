import type { FastifyBaseLogger } from 'fastify';
import { analyzeAttribution, type AttributionResult } from '../../core/attribution/attribution.js';
import { assertPathInsideLibrary } from '../utils/paths.js';
import { toLibraryRelative } from '../utils/rename-target.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { BookEventRow } from './types.js';

/**
 * Preflight failures are operator/config errors — NOT earwitness outcomes — so
 * they reject with a coded error (mapped to 400 in error-handler.ts) and record
 * no book event. Mirrors `RefreshScanError`'s NO_PATH → 400 precedent. The
 * out-of-library case throws `PathOutsideLibraryError` (also mapped to 400) from
 * `assertPathInsideLibrary` rather than a code here.
 */
export class AttributionAnalysisError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'NO_PATH' | 'LIBRARY_PATH_UNSET' | 'NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
    this.name = 'AttributionAnalysisError';
  }
}

export interface AttributionAnalysisOutcome {
  bookId: number;
  /** The recorded event's resolved outcome — mirrors `reason.outcome`. */
  outcome: AttributionResult['kind'];
  eventId: number;
}

/** Map the discriminated client result into the JSON `reason` blob the event
 * renderer consumes. Only provider outcomes reach here (preflight already
 * passed), so every branch records exactly one `attribution_analysis` event. */
function buildReason(
  result: AttributionResult,
  expected: { title: string; authors: string[]; narrators: string[] },
): Record<string, unknown> {
  if (result.kind === 'permanent_failure') {
    // 422 / other 4xx: undecodable audio OR ambiguous folder. Surface the
    // message verbatim so the human can tell re-rip from path issue. No retry.
    return { outcome: 'permanent_failure', status: result.status, message: result.message };
  }
  if (result.kind === 'transient_failure') {
    // 503 / busy / dependency down / timeout — client already did bounded retry.
    return {
      outcome: 'transient_failure',
      message: result.message,
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  }
  const { detection, comparison } = result;
  return {
    outcome: 'ok',
    attributionPresent: detection.attributionPresent,
    confidence: detection.confidence,
    comparisonStatus: comparison?.status ?? null,
    expected,
    detected: {
      title: detection.detected.title ?? null,
      authors: detection.detected.authors,
      narrators: detection.detected.narrators,
    },
    fields: comparison
      ? {
          title: comparison.fields.title,
          authors: comparison.fields.authors,
          narrators: comparison.fields.narrators,
        }
      : null,
  };
}

/**
 * Manual, per-book earwitness attribution analysis (1.0 testing-only). Validates
 * preconditions synchronously (no-path, library-path-unset, unconfigured,
 * out-of-library — all coded → 400, no client call, no event), then calls the
 * #1527 client and records the provider outcome as a single
 * `attribution_analysis` / `earwitness` book event. Never mutates book metadata.
 */
export async function analyzeBookAttribution(
  bookId: number,
  bookService: BookService,
  settingsService: SettingsService,
  eventHistory: EventHistoryService,
  log: FastifyBaseLogger,
): Promise<AttributionAnalysisOutcome> {
  const book = await bookService.getById(bookId);
  if (!book) {
    throw new AttributionAnalysisError('NOT_FOUND', `Book ${bookId} not found`);
  }
  if (!book.path) {
    throw new AttributionAnalysisError('NO_PATH', `Book ${bookId} has no library path — import it first`);
  }

  const library = await settingsService.get('library');
  const libraryRoot = library?.path?.trim();
  if (!libraryRoot) {
    throw new AttributionAnalysisError('LIBRARY_PATH_UNSET', 'Library path is not configured');
  }

  const earwitness = await settingsService.get('earwitness');
  const baseUrl = earwitness?.baseUrl?.trim();
  const apiKey = earwitness?.apiKey?.trim();
  if (!baseUrl || !apiKey) {
    throw new AttributionAnalysisError(
      'NOT_CONFIGURED',
      'earwitness is enabled but not fully configured — set the Base URL and API Key in Settings.',
    );
  }

  // Containment guard FIRST (rejects equality, `..` escapes, sibling-prefix, and
  // Windows cross-drive absolute-`relative()` results) — only compute the
  // library-relative path to send once containment is asserted. `toLibraryRelative`
  // is normalization-only and falls back to the absolute path for outside-root
  // books, so it must not stand in for this check (see CLAUDE.md / #769 lineage).
  assertPathInsideLibrary(book.path, libraryRoot);
  const relativePath = toLibraryRelative(book.path, libraryRoot);

  const expected = {
    title: book.title,
    authors: book.authors.map((a) => a.name),
    narrators: book.narrators.map((n) => n.name),
  };

  const result = await analyzeAttribution({ baseUrl, apiKey, path: relativePath, expected });

  log.info(
    { bookId, outcome: result.kind, ...(result.kind === 'ok' ? { comparisonStatus: result.comparison?.status ?? null } : {}) },
    'earwitness attribution analysis complete',
  );

  const event: BookEventRow = await eventHistory.create({
    bookId,
    ...snapshotBookForEvent(book),
    eventType: 'attribution_analysis',
    source: 'earwitness',
    reason: buildReason(result, expected),
  });

  return { bookId, outcome: result.kind, eventId: event.id };
}
