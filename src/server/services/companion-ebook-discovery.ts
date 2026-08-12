import { readdir, lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { isHiddenName } from '@core/utils/audio-constants.js';
import { isDefinitiveAbsence } from '../utils/fs-errno.js';
import { serializeError } from '../utils/serialize-error.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';

export interface CompanionCandidatesInput {
  bookId: number;
  bookPath: string;
}

/** Never return partial success: an unreadable possible candidate makes the result undetermined. */
export type CompanionCandidatesResult =
  /** Sorted basenames. */
  | { outcome: 'ok'; candidates: string[] }
  /** The directory is definitively absent. */
  | { outcome: 'gone' }
  /** The complete candidate set could not be determined. */
  | { outcome: 'undetermined' };

/** Locale-independent total order; localeCompare can tie case variants and destabilize indexes. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Run cheap lexical membership checks before lstat. */
function isLexicalCandidate(name: string, bookId: number, bookPath: string, log: FastifyBaseLogger): boolean {
  if (isHiddenName(name)) return false;
  if (extname(name).toLowerCase() !== '.epub') return false;
  if (!isPersistableCompanionBasename(name)) {
    // Callers only see unavailable, so log this otherwise invisible exclusion here.
    log.debug(
      { bookId, path: bookPath, filename: name },
      'Companion ebook candidate skipped — basename is not persistable',
    );
    return false;
  }
  return true;
}

/**
 * Discover regular, persistable, non-hidden top-level EPUBs without normalization. A visible
 * `*.tmp.epub` is valid; accepted basenames remain byte-for-byte unchanged. Definitive absence is
 * `gone`; every other read/probe failure is `undetermined` so callers retain prior observations.
 */
export async function findCompanionEbookCandidates(
  input: CompanionCandidatesInput,
  log: FastifyBaseLogger,
): Promise<CompanionCandidatesResult> {
  const { bookId, bookPath } = input;

  let entries: string[];
  try {
    entries = await readdir(bookPath);
  } catch (error: unknown) {
    log.debug({ bookId, path: bookPath, error: serializeError(error) }, 'Companion ebook candidate listing failed');
    return { outcome: isDefinitiveAbsence(error) ? 'gone' : 'undetermined' };
  }

  // Sort before probing so surviving order never depends on readdir order.
  const named = entries.filter((name) => isLexicalCandidate(name, bookId, bookPath, log)).sort(byCodePoint);

  const candidates: string[] = [];
  for (const name of named) {
    const path = join(bookPath, name);
    try {
      const stats = await lstat(path);
      if (stats.isFile()) candidates.push(name);
    } catch (error: unknown) {
      log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook candidate probe failed');
      // A file removed mid-enumeration is not a candidate; any other errno makes the call undetermined.
      if (!isDefinitiveAbsence(error)) return { outcome: 'undetermined' };
    }
  }

  return { outcome: 'ok', candidates };
}
