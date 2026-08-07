/**
 * Trailing promotional-chapter trim (#2168).
 *
 * #1942 corroborates a would-be `duration-mismatch` against the edition's chapter
 * table, which is a strictly more authoritative runtime than the `runtimeLengthMin`
 * scalar. But some Audible chapter tables END IN ADVERTISING — `End Credits`,
 * `Excerpt: …`, `Bonus Excerpt: …`, `… (Preview)` — content a clean retail rip
 * legitimately omits. The file is complete, the catalog number is padded, and the
 * book flags anyway (measured: 4 books in a 693-book library, −8m to −34m against
 * the full sum and within 87s of the trimmed one).
 *
 * This module is the rule that produces the second reference. It is PURE: no I/O,
 * no cache, no logging, and directly callable from `pnpm exec tsx` with a small
 * script file.
 *
 * **The walk is a contiguous-TAIL walk, and that conservatism is the feature.** It
 * starts at the last chapter and stops at the first chapter (scanning backward)
 * that does not match — it never inspects a chapter earlier than the stop point. A
 * match-anywhere filter would trim an `End Credits` chapter the file actually
 * CONTAINS, under-counting the catalog and manufacturing a mismatch in the
 * opposite direction. Legends & Lattes is the specimen that proves the walk stops
 * early: its final chapter is `Pages to Fill: A Legends & Lattes Story`, a named
 * bonus short story with none of the trigger words, so the walk halts on it and
 * never reaches the `End Credits` behind it — and the book keeps flagging, which
 * is correct (the file genuinely lacks content the edition includes).
 *
 * **Validity is deliberately NOT this rule's job.** The trimmed runtime rides raw
 * exactly as `runtimeLengthMs` itself does (see `ChapterRuntimeOutcome`) — `0`, a
 * negative, `NaN`, `±Infinity`, and anything that inherits them are rejected by
 * the service's ONE trust gate (`usableChapterSeconds`), applied identically to
 * both references. Re-checking any of it here would make the no-trim invariant
 * below un-satisfiable.
 */

/**
 * One chapter entry as the adapter parsed it. Both fields are `unknown` on
 * purpose: they come from an external API through a `.nullish()`/`.passthrough()`
 * schema whose per-entry parse falls back to `{}` (a malformed entry must degrade
 * the trim, never invalidate the record), so the rule narrows rather than trusts.
 * Not coercing IS the guard — a non-string title simply fails the pattern and
 * stops the walk.
 */
export interface ChapterTrimEntry {
  title?: unknown;
  lengthMs?: unknown;
  [key: string]: unknown;
}

/** The trim rule's named result. Both fields are defined independently. */
export interface ChapterTrimResult {
  /**
   * `runtimeLengthMs` minus the removed tail's lengths, RAW — no judgment about
   * the result's sign or finiteness. `undefined` in exactly two cases, both about
   * whether the arithmetic is MEANINGFUL rather than whether its result is
   * trustworthy: a non-numeric `runtimeLengthMs` (there is nothing to subtract
   * from — and JS coerces `null` to `0`, so a bare subtraction would silently
   * invent a runtime), and a non-empty list the walk consumed ENTIRELY. The
   * latter is not redundant with the service's trust gate: chapter lengths need
   * not sum to `runtimeLengthMs` (the endpoint publishes
   * `brandIntroDurationMs`/`brandOutroDurationMs` separately), so removing every
   * chapter can leave a small POSITIVE remainder the gate would otherwise accept
   * as a whole book's runtime.
   */
  trimmedRuntimeMs: number | undefined;
  /**
   * ALWAYS the number of chapters the backward walk removed — no exceptions, no
   * dependence on `runtimeLengthMs`. A first-class output rather than something a
   * caller re-derives: a TRUSTED zero-length trailing match is genuinely removed
   * while leaving `trimmedRuntimeMs === runtimeLengthMs`, so `trimmed !== full` is
   * not a valid trim detector.
   */
  trimmedChapterCount: number;
}

/**
 * The trailing-run trigger. Case-insensitive, unanchored substring, and
 * deliberately WITHOUT the `g` flag — a `g`-flagged shared regex carries
 * `lastIndex` across calls and would trim non-deterministically.
 */
export const PROMOTIONAL_TAIL_PATTERN = /excerpt|preview|bonus|end credits|also by|coming soon/i;

/**
 * Corroboration reference #2: the chapter total with its trailing promotional run
 * removed. See the module doc for why the walk is tail-only and why no validity
 * check happens here.
 */
export function computeTrimmedChapterRuntime(
  chapters: readonly ChapterTrimEntry[],
  runtimeLengthMs: number | null | undefined,
): ChapterTrimResult {
  let removedMs = 0;
  let trimmedChapterCount = 0;

  for (let i = chapters.length - 1; i >= 0; i--) {
    const entry: ChapterTrimEntry | undefined = chapters[i];
    const title = entry?.title;
    // A missing/null/non-string title never matches, so the walk stops on it.
    if (typeof title !== 'string' || !PROMOTIONAL_TAIL_PATTERN.test(title)) break;
    // A length that cannot be trusted cannot be subtracted — stop rather than
    // remove, even though the title matched. Exactly `0` IS trusted: such a
    // chapter is removed and counted, contributing 0 to the subtraction.
    const lengthMs = entry?.lengthMs;
    if (typeof lengthMs !== 'number' || !Number.isFinite(lengthMs) || lengthMs < 0) break;
    // No rollback: removals already accumulated when the walk later hits an
    // untrusted barrier stay removed and stay counted.
    removedMs += lengthMs;
    trimmedChapterCount++;
  }

  return {
    trimmedRuntimeMs: resolveTrimmedRuntime(chapters.length, trimmedChapterCount, removedMs, runtimeLengthMs),
    trimmedChapterCount,
  };
}

function resolveTrimmedRuntime(
  chapterCount: number,
  removedCount: number,
  removedMs: number,
  runtimeLengthMs: number | null | undefined,
): number | undefined {
  if (typeof runtimeLengthMs !== 'number') return undefined;
  // A structural refusal, not a validity one — see `ChapterTrimResult`.
  if (chapterCount > 0 && removedCount === chapterCount) return undefined;
  // The no-trim invariant: BIT-IDENTICAL to `runtimeLengthMs` for every numeric
  // value, `0`/negative/`NaN`/`±Infinity` included. This is what guarantees every
  // book without a trimmable tail behaves exactly as it does today.
  if (removedCount === 0) return runtimeLengthMs;
  return runtimeLengthMs - removedMs;
}
