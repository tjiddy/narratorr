/**
 * Removes only a contiguous promotional tail from an edition's published runtime.
 * A match-anywhere filter could remove content the local file actually contains.
 * Runtime validity remains the service's job; this rule preserves raw numeric results.
 */

/** External chapter fields stay unknown so malformed entries stop, rather than invalidate, trimming. */
export interface ChapterTrimEntry {
  title?: unknown;
  lengthMs?: unknown;
  [key: string]: unknown;
}

export interface ChapterTrimResult {
  /**
   * Published runtime minus the removed tail, without sign or finiteness validation.
   * Undefined when the runtime is non-numeric or a non-empty list is fully consumed.
   */
  trimmedRuntimeMs: number | undefined;
  /** Removed chapter count, independent of runtime; zero-length matches still count. */
  trimmedChapterCount: number;
}

/** Deliberately not global: a shared `g` regex would carry lastIndex across calls. */
export const PROMOTIONAL_TAIL_PATTERN = /excerpt|preview|bonus|end credits|also by|coming soon/i;

export function computeTrimmedChapterRuntime(
  chapters: readonly ChapterTrimEntry[],
  runtimeLengthMs: number | null | undefined,
): ChapterTrimResult {
  let removedMs = 0;
  let trimmedChapterCount = 0;

  for (let i = chapters.length - 1; i >= 0; i--) {
    const entry: ChapterTrimEntry | undefined = chapters[i];
    const title = entry?.title;
    if (typeof title !== 'string' || !PROMOTIONAL_TAIL_PATTERN.test(title)) break;
    // Zero is valid; any untrusted matched length stops the walk.
    const lengthMs = entry?.lengthMs;
    if (typeof lengthMs !== 'number' || !Number.isFinite(lengthMs) || lengthMs < 0) break;
    // A later barrier does not roll back removals already accumulated.
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
  // Structural refusal: a non-empty list consumed entirely cannot yield a meaningful runtime.
  if (chapterCount > 0 && removedCount === chapterCount) return undefined;
  // Preserve every numeric value bit-for-bit when nothing was trimmed.
  if (removedCount === 0) return runtimeLengthMs;
  return runtimeLengthMs - removedMs;
}
