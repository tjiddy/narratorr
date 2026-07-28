import { readdir, lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { isHiddenName } from '@core/utils/audio-constants.js';
import { isDefinitiveAbsence } from '../utils/fs-errno.js';
import { serializeError } from '../utils/serialize-error.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';

export interface CompanionCandidatesInput {
  /** Public book id, carried for the log identity — mirrors `CompanionOpenInput`. */
  bookId: number;
  /** `books.path` — the book's library folder. */
  bookPath: string;
}

/**
 * The failure contract is explicit because a partial list is DATA-AFFECTING for the
 * reconciler (#1959): returning the readable subset as `ok` is exactly how a good observation
 * gets overwritten by one that silently dropped an unreadable candidate.
 */
export type CompanionCandidatesResult =
  /** Sorted basenames, in the total order below. */
  | { outcome: 'ok'; candidates: string[] }
  /** `readdir` ENOENT/ENOTDIR — the directory is absent. */
  | { outcome: 'gone' }
  /** Any other `readdir` errno, a code-less throw, or a non-absence per-entry `lstat` errno. */
  | { outcome: 'undetermined' };

/**
 * Total, locale-independent code-point order over the raw basename.
 *
 * Explicitly NOT `localeCompare` and NOT `compareAudioNames`: base/accent-insensitive
 * comparators tie `A.epub` with `a.epub` and let `readdir` order show through, which would let
 * a server-issued candidate index move under an unchanged directory. Two entries in one
 * directory cannot share a basename, so this never ties and the index is total.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Terms 1-3 of AC10's membership predicate — the lexical ones, evaluated before any `lstat`
 * so the syscall is only paid for names that could still qualify.
 */
function isLexicalCandidate(name: string, bookId: number, bookPath: string, log: FastifyBaseLogger): boolean {
  if (isHiddenName(name)) return false;
  if (extname(name).toLowerCase() !== '.epub') return false;
  if (!isPersistableCompanionBasename(name)) {
    // The one exclusion an operator cannot diagnose from the panel: §7's `unavailable` copy
    // tells them to drop an `.epub` in and rescan, which they have already done. No `error`
    // key — nothing was caught here.
    log.debug(
      { bookId, path: bookPath, filename: name },
      'Companion ebook candidate skipped — basename is not persistable',
    );
    return false;
  }
  return true;
}

/**
 * The single home of "which files are companion-ebook candidates" (#1974 AC9-AC14, plan §5).
 *
 * Membership is a **total predicate over top-level entries only** — it never recurses into
 * disc or extras folders. An entry is a candidate iff all four hold: it is not born hidden ·
 * its extension is `.epub`, case-insensitively · `isPersistableCompanionBasename` accepts it ·
 * its `lstat` reports a regular file. "Temp name" means born-hidden and nothing more, per the
 * repository-wide `audio-constants.ts` convention: `.book.epub` is excluded by the dotfile
 * rule, `book.epub.part` by the extension rule, and a **visible `book.tmp.epub` IS a
 * candidate** — Narratorr's own staging never produces one, so a visible file is a file the
 * owner placed.
 *
 * Term 3 is not cosmetic. The production filesystem is Alpine Linux, where `sub\book.epub` is
 * a legal SINGLE filename and ` book.epub` likewise — both pass the other three terms, and
 * both are refused by the observation write boundary. Without it, discovery could emit a
 * candidate the reconciler cannot persist and the opener refuses as `invalid_filename`: a name
 * the owner could select but nothing downstream could store or open.
 *
 * **Validate, never normalise.** A rejected entry is skipped, not repaired — a trimmed name no
 * longer names the real directory entry. Accepted names are carried byte-for-byte.
 *
 * Every catch logs at `debug` in the shared `{ bookId, path, error: serializeError(error) }`
 * shape BEFORE the error is erased, including the skipped-entry branch: the result union
 * discards the caught value, so no caller can log it after the return. That is why the logger
 * is an input.
 *
 * Caller dispositions are fixed by AC14: the owner routes map `gone` → `404` and
 * `undetermined` → `503`; the reconciler must treat `undetermined` as retain-the-last-
 * observation and write nothing.
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

  // Sorted BEFORE the `lstat` pass so the probe order — and therefore the surviving order —
  // is a property of this comparator rather than of whatever order `readdir` happened to yield.
  const named = entries.filter((name) => isLexicalCandidate(name, bookId, bookPath, log)).sort(byCodePoint);

  const candidates: string[] = [];
  for (const name of named) {
    const path = join(bookPath, name);
    try {
      const stats = await lstat(path);
      if (stats.isFile()) candidates.push(name);
    } catch (error: unknown) {
      log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook candidate probe failed');
      // A file removed mid-enumeration is simply not a candidate. Any other errno means this
      // entry MIGHT be a candidate, so the whole call is undetermined.
      if (!isDefinitiveAbsence(error)) return { outcome: 'undetermined' };
    }
  }

  return { outcome: 'ok', candidates };
}
