import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { EpubValidation } from '@core/epub/result.js';
import { validateEpub } from '@core/epub/validate.js';
import { serializeError } from '../utils/serialize-error.js';
import { findCompanionEbookCandidates } from './companion-ebook-discovery.js';
import type { CompanionEbookObservation } from './companion-ebook-observation.js';
import type { CompanionEbookRow } from './types.js';

/**
 * Pure filesystem pass: no DB, lock, or writes; the reconciler owns those. It never throws:
 * disk/validation failures log once and return retain, preserving the last good observation.
 * Use validateEpub, not inspectEpub, to avoid reading up to 8 MiB of cover data per sweep item.
 */

export interface CompanionObserveInput {
  bookId: number;
  /** Re-read from books.path inside the reconciler's admission lock. */
  bookPath: string;
  /** Context only; eligibility and the serve-time opener own containment. */
  libraryRoot: string;
  prior: CompanionEbookRow | null;
  /**
   * A user refresh bypasses the fingerprint because unchanged bytes can retain an obsolete validator
   * verdict. Bulk sweeps pass false. Keep required so future callers cannot inherit a silent default.
   */
  force: boolean;
}

export type CompanionObserveResult =
  | { outcome: 'observed'; observation: CompanionEbookObservation }
  | { outcome: 'unchanged' }
  /** Write nothing; preserve the last successful observation. */
  | { outcome: 'retain' };

export type CompanionRevalidateResult = Exclude<CompanionObserveResult, { outcome: 'unchanged' }>;

export interface Fingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** before is caller-owned; re-taking it here adds a third syscall and breaks the pinned order. */
export interface CompanionRevalidateInput {
  bookId: number;
  path: string;
  filename: string;
  selected: boolean;
  candidateCount: number;
  before: Fingerprint;
}

type Resolution =
  | { kind: 'file'; filename: string; selected: boolean }
  | { kind: 'ambiguous' };

/** none and ambiguous have no file fingerprint to compare. */
const SHORT_CIRCUITABLE: ReadonlySet<string> = new Set(['available', 'invalid', 'drm_protected']);

// Match DB normalization with trunc: floor diverges for admitted negatives, while raw fractional
// timestamps prevent fingerprint equality.
function fingerprintOf(stats: Stats): Fingerprint {
  return { sizeBytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs), ctimeMs: Math.trunc(stats.ctimeMs) };
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// Live prior selection wins, then a lone unselected candidate; otherwise remain ambiguous.
// Never guess when a selected file vanished or ownership silently moves to another file.
function resolveCandidate(candidates: string[], prior: CompanionEbookRow | null): Resolution {
  const selected = prior?.selectedFilename ?? null;
  if (selected !== null && candidates.includes(selected)) {
    return { kind: 'file', filename: selected, selected: true };
  }
  if (candidates.length === 1) return { kind: 'file', filename: candidates[0]!, selected: false };
  return { kind: 'ambiguous' };
}

/**
 * Shared pre/post lstat; null means retain. A numeric fingerprint does not imply a regular file,
 * so reject directories, symlinks, FIFOs, and devices separately.
 */
export async function statRegularFile(
  bookId: number,
  path: string,
  log: FastifyBaseLogger,
): Promise<Fingerprint | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      // No error field: lstat succeeded but discovery disagreed.
      log.debug({ bookId, path }, 'Companion ebook candidate is not a regular file — retaining the last observation');
      return null;
    }
    return fingerprintOf(stats);
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook candidate stat failed — retaining the last observation');
    return null;
  }
}

// Any mismatch revalidates. ctime prevents a size+mtime-preserving replacement from inheriting
// an available verdict without structural validation.
function isUnchanged(
  prior: CompanionEbookRow | null,
  resolution: { filename: string; selected: boolean },
  fingerprint: Fingerprint,
  candidateCount: number,
): boolean {
  if (prior === null || !SHORT_CIRCUITABLE.has(prior.status)) return false;
  return (
    prior.filename === resolution.filename &&
    prior.sizeBytes === fingerprint.sizeBytes &&
    prior.mtimeMs === fingerprint.mtimeMs &&
    prior.ctimeMs === fingerprint.ctimeMs &&
    prior.candidateCount === candidateCount &&
    (prior.selectedFilename !== null) === resolution.selected
  );
}

/** Narrow validation codes here so the DB row can remain string|null without a runtime enum. */
function toObservation(
  validation: EpubValidation,
  resolution: { filename: string; selected: boolean },
  fingerprint: Fingerprint,
  candidateCount: number,
): CompanionEbookObservation {
  const fileFields = { filename: resolution.filename, ...fingerprint, candidateCount, selected: resolution.selected };
  if (validation.status === 'available') return { status: 'available', ...fileFields };
  if (validation.status === 'drm_protected') return { status: 'drm_protected', ...fileFields };
  return { status: 'invalid', ...fileFields, validationCode: validation.code };
}

/**
 * Shared tail: validate→post-stat→compare; failure or movement returns retain. runObserve uses
 * the module-local binding, so mocking this export affects external selection but not its internal sweep call.
 */
export async function revalidateCompanionFile(
  input: CompanionRevalidateInput,
  log: FastifyBaseLogger,
): Promise<CompanionRevalidateResult> {
  const { bookId, path, filename, selected, candidateCount, before } = input;

  let validation: EpubValidation;
  try {
    validation = await validateEpub(path);
  } catch (error: unknown) {
    // ENOENT may mean readdir/open raced; one stale pass is safer than clobbering from a partial view.
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook validation failed — retaining the last observation');
    return { outcome: 'retain' };
  }

  const after = await statRegularFile(bookId, path, log);
  if (after === null || !sameFingerprint(after, before)) return { outcome: 'retain' };

  return { outcome: 'observed', observation: toObservation(validation, { filename, selected }, before, candidateCount) };
}

// Fixed order: discover→resolve→lstat→short-circuit→validate→lstat. Pass the first fingerprint
// into the tail; force bypasses only the short-circuit, and tests pin both lstat sequences.
async function runObserve(input: CompanionObserveInput, log: FastifyBaseLogger): Promise<CompanionObserveResult> {
  const { bookId, bookPath, prior, force } = input;

  const discovery = await findCompanionEbookCandidates({ bookId, bookPath }, log);
  // gone means retain, not none: a remounting share may lie with ENOENT, and exposure is status-gated.
  if (discovery.outcome !== 'ok') return { outcome: 'retain' };

  const { candidates } = discovery;
  if (candidates.length === 0) return { outcome: 'observed', observation: { status: 'none' } };

  const resolution = resolveCandidate(candidates, prior);
  if (resolution.kind === 'ambiguous') {
    return { outcome: 'observed', observation: { status: 'ambiguous', candidateCount: candidates.length } };
  }

  const path = join(bookPath, resolution.filename);
  const before = await statRegularFile(bookId, path, log);
  if (before === null) return { outcome: 'retain' };

  if (!force && isUnchanged(prior, resolution, before, candidates.length)) return { outcome: 'unchanged' };

  return revalidateCompanionFile(
    {
      bookId,
      path,
      filename: resolution.filename,
      selected: resolution.selected,
      candidateCount: candidates.length,
      before,
    },
    log,
  );
}

/** Backstop for unforeseen failures; expected errors are caught locally to preserve their exact path. */
export async function observeCompanionEbook(
  input: CompanionObserveInput,
  log: FastifyBaseLogger,
): Promise<CompanionObserveResult> {
  try {
    return await runObserve(input, log);
  } catch (error: unknown) {
    log.debug(
      { bookId: input.bookId, path: input.bookPath, error: serializeError(error) },
      'Companion ebook observation failed — retaining the last observation',
    );
    return { outcome: 'retain' };
  }
}
