import type { EpubValidationCode } from '@core/epub/result.js';
import { ApiError } from '@/lib/api';
import type { BadgeVariant } from '@/components/Badge';
import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';

// Single home for Ebook copy (#1963): no em dashes, filesystem-watching verbs, or visible
// "companion" terminology. Render tests scan text, aria-labels, titles, and toasts.
export const SECTION_HEADING = 'Ebook';

/** `ambiguous` is dynamic; these four pill labels are constant. */
export const PILLS = {
  available: 'Available',
  none: 'None',
  invalid: 'Not readable',
  drm_protected: 'DRM-protected',
} as const;

/** Use the rendered candidate array length, never the separately reported count. */
export function ambiguousPill(candidateCount: number): string {
  return `${candidateCount} found`;
}

export const BADGE_VARIANTS: Record<CompanionEbookStatus, BadgeVariant> = {
  available: 'success',
  none: 'muted',
  ambiguous: 'warning',
  invalid: 'danger',
  drm_protected: 'warning',
};

export const DOWNLOAD_LABEL = 'Download EPUB';

/** Count comes only from `toc.length`; extraction returns null rather than an empty TOC (#2022). */
export function chapterCountText(count: number): string {
  return `${count} chapter${count === 1 ? '' : 's'}`;
}

export const DETAIL_SEPARATOR = ' · ';

/** This ebook-only action is “Re-check”; “rescan” means the whole-book audio action (#2034). */
export const REFRESH_LABEL = 'Re-check ebook';

export const REFRESH_ERROR_TOAST = "Couldn't re-check the ebook. Try again in a moment.";

// Split only to render `.epub` as code while preserving the exact accessible sentence.
export const NONE_BODY_PREFIX = 'Drop a single ';
export const NONE_BODY_CODE = '.epub';
export const NONE_BODY_SUFFIX = " into this book's folder, shown under Location below, then rescan.";
export const NONE_BODY = `${NONE_BODY_PREFIX}${NONE_BODY_CODE}${NONE_BODY_SUFFIX}`;

export const AMBIGUOUS_QUESTION = 'Which one belongs to this book?';
export const AMBIGUOUS_SUBMIT = 'Use this one';
export const SELECTION_SUCCESS_TOAST = 'Ebook selection saved';

/** DRM blocks Kindle conversion, not the owner's download (#2038). */
export const DRM_BODY =
  "Its chapters are encrypted. Narratorr won't remove DRM, so this can't be sent to Kindle.";

/**
 * Exhaustive per-code owner-facing diagnoses; new validation codes fail typecheck.
 * Tests pin every complete sentence because swapped clauses give false diagnoses.
 */
export const INVALID_REASONS: Record<EpubValidationCode, string> = {
  not_a_zip: "it isn't a readable archive",
  truncated: 'the file is incomplete',
  bad_mimetype: "it isn't marked as an EPUB",
  missing_container: 'it has no index',
  unresolvable_package: "its index points to a file that isn't there",
  empty_manifest: 'it lists no files',
  empty_spine: 'it has no reading order',
  unsafe_entry_path: 'it contains an unsafe file path',
  duplicate_entry: 'it contains duplicate entries',
  malformed_xml: 'its internal structure is damaged',
  limit_exceeded: "it's larger or more complex than Narratorr will read",
};

export const INVALID_SENTENCE_FALLBACK =
  "This isn't a valid EPUB. If it's still copying, wait and rescan.";

/** The wire value is unconstrained text; own-property checking prevents prototype names rendering as copy. */
export function invalidSentence(code: string | null): string {
  if (code !== null && Object.hasOwn(INVALID_REASONS, code)) {
    return `This isn't a valid EPUB: ${INVALID_REASONS[code as EpubValidationCode]}. If it's still copying, wait and rescan.`;
  }
  return INVALID_SENTENCE_FALLBACK;
}

/**
 * Map selection failures by status, never non-contractual server text that leaks banned terminology.
 * Both 409 variants share the same refresh action.
 */
export const SELECTION_ERROR_FALLBACK = "Your choice couldn't be saved. Try again in a moment.";

const SELECTION_ERRORS: Record<number, string> = {
  400: 'That file is no longer in the list. Pick again.',
  404: "That ebook isn't there anymore. Rescan and try again.",
  409: 'Something changed while you were choosing. Refresh the page and try again.',
  503: SELECTION_ERROR_FALLBACK,
};

export function selectionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && Object.hasOwn(SELECTION_ERRORS, error.status)) {
    return SELECTION_ERRORS[error.status]!;
  }
  return SELECTION_ERROR_FALLBACK;
}
