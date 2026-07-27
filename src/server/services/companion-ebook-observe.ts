import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { EpubValidation } from '../../core/epub/result.js';
// Deep path, never a `core/index.js` barrel: #1956's scope note reserved a barrel export for a
// consumer that actually wants one, and this issue does not (#1959 AC13).
import { validateEpub } from '../../core/epub/validate.js';
import { serializeError } from '../utils/serialize-error.js';
import { findCompanionEbookCandidates } from './companion-ebook-discovery.js';
import type { CompanionEbookObservation } from './companion-ebook-observation.js';
import type { CompanionEbookRow } from './types.js';

/**
 * The per-book companion-ebook pass (#1959, plan §3/§6): discovery + `lstat` + `validateEpub`
 * composed into either an observation to persist, a short-circuit, or a retain signal.
 *
 * **No DB access and no lock.** Every branch below is therefore unit-testable without a
 * database, and the reconciler stays free to decide *where* the lock boundary sits. The
 * conditional write, the transaction, and the sweep all live in
 * `companion-ebook-reconciler.ts`.
 *
 * **It never throws.** Every errno, every code-less throw, and every rejection out of
 * `validateEpub` is absorbed and returned as `retain`, logged exactly once at `debug` in the
 * established `{ bookId, path, error: serializeError(error) }` shape before the union discards
 * it. A reconciler that has to distinguish "nothing changed" from "the disk lied to us" cannot
 * do so from a thrown value it has already lost.
 *
 * **`validateEpub`, never `inspectEpub`.** Inspection pulls up to 8 MiB of cover bytes per
 * book; a six-hourly sweep over a whole library must not. The panel is `inspectEpub`'s caller.
 */

export interface CompanionObserveInput {
  /** Public book id, carried for the log identity — the shape `library-scan.service.ts` emits. */
  bookId: number;
  /** `books.path`, re-read inside the reconciler's admission lock. */
  bookPath: string;
  /**
   * `settings.library.path`. Containment is NOT re-decided here —
   * `isCompanionEbookEligible` already gated the folder and `companion-ebook-open.ts` owns
   * the serve-time authority on the file. Carried so the pass's inputs name the whole
   * filesystem context it ran against.
   */
  libraryRoot: string;
  /** The stored observation, read inside the same lock — the short-circuit's only input. */
  prior: CompanionEbookRow | null;
}

export type CompanionObserveResult =
  /** A fresh observation the reconciler should persist under its precondition. */
  | { outcome: 'observed'; observation: CompanionEbookObservation }
  /** The AC9 short-circuit hit: same file, same fingerprint, same selection state. */
  | { outcome: 'unchanged' }
  /** Write NOTHING — the last successful observation is better than anything we could derive. */
  | { outcome: 'retain' };

/** The three `size`/`mtime`/`ctime` columns, already normalised for storage and comparison. */
interface Fingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** Which candidate this pass is about, and whether it is the owner's recorded pick. */
type Resolution =
  | { kind: 'file'; filename: string; selected: boolean }
  | { kind: 'ambiguous' };

/**
 * The statuses whose rows carry a comparable fingerprint. `none` and `ambiguous` carry no file
 * columns at all, so there is nothing for the short-circuit to match against.
 */
const SHORT_CIRCUITABLE: ReadonlySet<string> = new Set(['available', 'invalid', 'drm_protected']);

/**
 * `Math.trunc`, never `Math.floor` — `src/db/schema.ts` and
 * `companion-ebook-observation.ts` both fix the choice, and the write boundary truncates.
 * The two agree on positive values but diverge across the signed domain the schema
 * deliberately admits (`Math.trunc(-123.75) === -123`, `Math.floor(-123.75) === -124`), and
 * `Stats.mtimeMs` is fractional — so comparing raw floats would make the short-circuit never
 * fire, for every book, on every sweep.
 */
function fingerprintOf(stats: Stats): Fingerprint {
  return { sizeBytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs), ctimeMs: Math.trunc(stats.ctimeMs) };
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * AC6's precedence, and it deliberately has no fourth rule: a live prior selection wins · a
 * lone candidate is used unselected · **everything else is `ambiguous`**.
 *
 * The last clause covers the case that looks like it wants a guess — a prior selection that is
 * no longer on disk. Picking "another one" would silently re-point the owner's choice at a file
 * they never chose, so the fallback is `ambiguous` and the panel re-asks.
 */
function resolveCandidate(candidates: string[], prior: CompanionEbookRow | null): Resolution {
  const selected = prior?.selectedFilename ?? null;
  if (selected !== null && candidates.includes(selected)) {
    return { kind: 'file', filename: selected, selected: true };
  }
  if (candidates.length === 1) return { kind: 'file', filename: candidates[0]!, selected: false };
  return { kind: 'ambiguous' };
}

/**
 * `lstat` + regular-file check, returning `null` for "retain" and logging the canonical record
 * at both catch sites. Shared by the pre-validation stat (AC8) and the post-validation
 * re-check (AC12) so the two can never drift in shape or in log identity.
 *
 * Regular-file status is a SEPARATE invariant from the numeric fingerprint, not an implication
 * of it: `lstat` reports `size`/`mtime`/`ctime` for a directory, symlink, FIFO, or device just
 * as readily, so a same-fingerprint replacement by a non-regular entry would otherwise pass.
 * `companion-ebook-open.ts` draws the same two checks apart for the same reason.
 */
async function statRegularFile(
  bookId: number,
  path: string,
  log: FastifyBaseLogger,
): Promise<Fingerprint | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      // No `error` key — nothing was caught, this is a disagreement with discovery.
      log.debug({ bookId, path }, 'Companion ebook candidate is not a regular file — retaining the last observation');
      return null;
    }
    return fingerprintOf(stats);
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook candidate stat failed — retaining the last observation');
    return null;
  }
}

/**
 * AC9's conjunction, in full. Any mismatch — including a ctime-only change — forces full
 * revalidation on this pass.
 *
 * `ctime` is not decoration: without it a same-path replacement that preserves size *and*
 * mtime (`cp -p`, `rsync --times`, an edit inside one mtime tick) satisfies the short-circuit
 * and is never structurally revalidated, so unvalidated bytes inherit an `available` verdict.
 */
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

/**
 * AC10's mapping. The `EpubValidationCode` → `validation_code` narrowing happens HERE by
 * construction, which is why `CompanionEbookRow.validationCode` stays `string | null` and
 * `src/core/epub/result.ts` needs no runtime enum.
 */
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
 * The fixed AC3 step order: discovery → resolve → `lstat` → short-circuit → `validateEpub` →
 * post-validation `lstat` re-check.
 */
async function runObserve(input: CompanionObserveInput, log: FastifyBaseLogger): Promise<CompanionObserveResult> {
  const { bookId, bookPath, prior } = input;

  const discovery = await findCompanionEbookCandidates({ bookId, bookPath }, log);
  // `gone` is RETAIN, not `none`. Exposure is already gated on `books.status === 'imported'`,
  // which `library-scan.service.ts` owns, so writing `none` from a possibly-lying `ENOENT` on a
  // re-mounting share buys nothing and destroys a good observation.
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

  if (isUnchanged(prior, resolution, before, candidates.length)) return { outcome: 'unchanged' };

  let validation: EpubValidation;
  try {
    validation = await validateEpub(path);
  } catch (error: unknown) {
    // Includes `ENOENT` — the candidate vanished between `readdir` and the open. The next pass
    // re-enumerates and writes `none` from a complete view, so one stale pass is the correct
    // cost of never clobbering on a partial one.
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook validation failed — retaining the last observation');
    return { outcome: 'retain' };
  }

  const after = await statRegularFile(bookId, path, log);
  if (after === null || !sameFingerprint(after, before)) return { outcome: 'retain' };

  return { outcome: 'observed', observation: toObservation(validation, resolution, before, candidates.length) };
}

/**
 * Observe one book's companion-ebook state. See the module doc comment for the contract.
 *
 * The outer catch is a backstop, not the primary absorb site: every expected failure is caught
 * where it happens so its `path` is the specific one that failed. Anything that reaches here is
 * unforeseen, and the AC2 guarantee — this function never throws — has to hold for those too.
 */
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
