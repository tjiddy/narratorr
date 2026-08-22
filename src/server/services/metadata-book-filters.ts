import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '@core/index.js';
import { filterByLanguage } from '@core/utils/index.js';
import { parseWordList, matchesWord } from '@shared/parse-word-list.js';
import type { SettingsService } from './settings.service.js';
import { serializeError } from '../utils/serialize-error.js';
import { collapseDuplicateRecordings } from './metadata-recording-collapse.js';

/**
 * Log message for the search-path collapse. `debug` rather than `info`: a collapse is the ordinary
 * success case, and this line exists so a suspected false merge can be diagnosed from logs alone.
 */
export const DUPLICATE_EDITIONS_COLLAPSED = 'Duplicate catalog editions collapsed — one recording kept';

export const KNOWN_PODCAST_TYPES = new Set(['PodcastParent', 'Periodical']);

// Deliberately narrower than NARRATOR_PLACEHOLDERS: widening this set changes the
// reject-word surface. metadata.service.test.ts pins the subset relationship.
export const PSEUDO_NARRATORS = new Set(['full cast', 'various', 'unknown']);

function isPseudoNarrator(name: string): boolean {
  return PSEUDO_NARRATORS.has(name.trim().toLowerCase().replace(/\s+/g, ' '));
}

// Shared by search and v1 add-by-ASIN so reject-word behavior cannot drift;
// settings reads and fail-open handling remain at each call site.
export function isRejectedByWords(book: BookMetadata, rejectWords: string): boolean {
  const rejectList = parseWordList(rejectWords);
  if (rejectList.length === 0) return false;

  const authorNames = (book.authors ?? []).map((a) => a.name).join(' ');
  const narrators = (book.narrators ?? [])
    .filter((n) => !isPseudoNarrator(n))
    .join(' ');
  const surface = `${book.title} ${book.subtitle ?? ''} ${authorNames} ${narrators} ${book.formatType ?? ''}`.toLowerCase();
  return rejectList.some((word) => matchesWord(surface, word));
}

export interface BookFilterDeps {
  settingsService?: SettingsService | undefined;
  log: FastifyBaseLogger;
}

// Each filter owns its settings read and fails open independently (#1004).
export async function applyBookFilters(
  deps: BookFilterDeps,
  books: BookMetadata[],
  preferAsin?: string | undefined,
): Promise<BookMetadata[]> {
  if (books.length === 0) return books;
  const audiobooksOnly = filterToAudiobooksOnly(deps, books);
  const rejectFiltered = await filterRejectedBooks(deps, audiobooksOnly);
  const languageFiltered = await filterBooksByLanguage(deps, rejectFiltered);
  const filtered = await filterByMinDuration(deps, languageFiltered);
  // Terminal on purpose (#1597): a listing the filters above rejected must be able neither to
  // become the canonical nor to donate its ASIN to one. `preferAsin` is threaded only from the
  // resolver, whose own requested-ASIN override this collapse would otherwise pre-empt.
  const { books: collapsed, collapses } = collapseDuplicateRecordings(filtered, preferAsin);
  collapses.forEach((collapse) => deps.log.debug(collapse, DUPLICATE_EDITIONS_COLLAPSED));
  return collapsed;
}

function filterToAudiobooksOnly(deps: BookFilterDeps, books: BookMetadata[]): BookMetadata[] {
  return books.filter((book) => {
    if (book.contentDeliveryType === undefined) return true;
    if (!KNOWN_PODCAST_TYPES.has(book.contentDeliveryType)) return true;
    deps.log.debug(
      { title: book.title, contentDeliveryType: book.contentDeliveryType },
      'Dropping non-audiobook from search results',
    );
    return false;
  });
}

async function filterBooksByLanguage(deps: BookFilterDeps, books: BookMetadata[]): Promise<BookMetadata[]> {
  if (!deps.settingsService) return books;

  let languages: readonly string[];
  try {
    const metadata = await deps.settingsService.get('metadata');
    languages = metadata.languages;
  } catch (error: unknown) {
    deps.log.warn({ error: serializeError(error) }, 'Failed to read language settings for search filtering — returning unfiltered results');
    return books;
  }

  return filterByLanguage(books, languages).kept;
}

async function filterRejectedBooks(deps: BookFilterDeps, books: BookMetadata[]): Promise<BookMetadata[]> {
  if (!deps.settingsService) return books;
  if (books.length === 0) return books;

  let rejectWords: string;
  try {
    const quality = await deps.settingsService.get('quality');
    rejectWords = quality.rejectWords;
  } catch (error: unknown) {
    deps.log.warn({ error: serializeError(error) }, 'Failed to read reject-words setting — returning unfiltered results');
    return books;
  }

  return books.filter((book) => !isRejectedByWords(book, rejectWords));
}

async function filterByMinDuration(deps: BookFilterDeps, books: BookMetadata[]): Promise<BookMetadata[]> {
  if (!deps.settingsService) return books;
  if (books.length === 0) return books;

  let minDurationMinutes: number;
  try {
    const metadata = await deps.settingsService.get('metadata');
    minDurationMinutes = metadata.minDurationMinutes;
  } catch (error: unknown) {
    deps.log.warn({ error: serializeError(error) }, 'Failed to read minDurationMinutes setting — returning unfiltered results');
    return books;
  }

  if (minDurationMinutes <= 0) return books;

  return books.filter((book) => book.duration == null || book.duration >= minDurationMinutes);
}
