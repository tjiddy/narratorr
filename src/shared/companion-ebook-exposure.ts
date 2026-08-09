import type { BookStatus } from './schemas/book.js';
import type { CompanionEbookStatus } from './schemas/companion-ebook.js';

export interface CompanionEbookExposureInput {
  enabled: boolean;
  bookStatus: BookStatus;
  observationStatus: CompanionEbookStatus | null | undefined;
}

// Keep shared terms private so callers can choose only the two named policies below.
function isCompanionEbookVisible(
  input: CompanionEbookExposureInput,
  permittedStatuses: readonly CompanionEbookStatus[],
): boolean {
  return (
    input.enabled &&
    input.bookStatus === 'imported' &&
    input.observationStatus != null &&
    permittedStatuses.includes(input.observationStatus)
  );
}

/** Advertisement is necessary, not proof the file opens; streaming performs the live
 * containment and regular-file checks. Reconciliation can leave imported stale after
 * transient mount errors, so a click may cleanly 404 until the next observation.
 * Keep the imported check: missing books retain companion rows. Do not add filesystem
 * work here; shared is client-importable and batch producers must not stat every result. */
export function isCompanionEbookExposed(input: CompanionEbookExposureInput): boolean {
  return isCompanionEbookVisible(input, ['available']);
}

/** Owner reads also admit stored drm_protected rows to tolerate classifier false positives;
 * public advertisement does not because DRM cannot be sent to Kindle. Live inspection remains
 * authoritative, so this does not make genuinely encrypted content readable. */
export function isCompanionEbookOwnerReadable(input: CompanionEbookExposureInput): boolean {
  return isCompanionEbookVisible(input, ['available', 'drm_protected']);
}
