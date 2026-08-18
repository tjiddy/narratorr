import type { RecordingCandidate } from '@core/utils/recording-identity.js';
import type { buildTargetPath } from '../utils/import-helpers.js';
import type { BookWithAuthor } from './book.service.js';

/**
 * Every naming input `copyToLibrary` derives, sourced from the incumbent row instead of the offer.
 *
 * `copyToLibrary` has TWO naming consumers and an override that covers only one makes the base
 * folder and the collision folder disagree, so both are declared here — and both are typed FROM
 * their consumer rather than restated. A new folder token's backing field (a new required member of
 * `buildTargetPath`'s book parameter) or a new `RecordingCandidate` member therefore becomes a
 * compile error inside `buildAttachNaming`, not a review finding two rounds later. Do not restate
 * this field list anywhere else.
 */
export interface AttachNaming {
  /** Feeds `buildTargetPath`; its separate `authorName` argument travels alongside. */
  targetBook: Parameters<typeof buildTargetPath>[2];
  authorName: string | null;
  /** Feeds occupied-target disambiguation through `deriveEditionLabel`. */
  candidate: RecordingCandidate;
  productionType: string | undefined;
  /** An incumbent carrying a stable label must land in its labelled folder, not the bare base. */
  seedEditionLabel: string;
}

/** The single mapping from an incumbent row to the naming inputs, used by both attach entry points. */
export function buildAttachNaming(book: BookWithAuthor): AttachNaming {
  const narratorNames = book.narrators?.map((n) => n.name) ?? [];
  const authorName = book.authors?.[0]?.name ?? null;
  // Stored productionType is already canonical; `unknown` carries no signal to the edition label.
  const productionType = book.productionType ?? undefined;
  return {
    targetBook: {
      title: book.title,
      seriesName: book.seriesName,
      seriesPosition: book.seriesPosition,
      narrators: narratorNames.map((name) => ({ name })),
      publishedDate: book.publishedDate,
    },
    authorName,
    candidate: {
      title: book.title,
      authors: authorName ? [authorName] : [],
      narrators: narratorNames,
      asin: book.asin,
      duration: book.duration,
      productionType,
    },
    productionType,
    seedEditionLabel: book.editionLabel ?? '',
  };
}
