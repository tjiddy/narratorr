import type { RecordingReviewReason } from '@core/utils/recording-identity.js';
import type { BookService, BookWithAuthor } from '../book.service.js';

/** Everything any caller can know about the recording being offered. Callers supply only the
 * fields they actually have; an omitted field must stay omitted all the way to the candidate. */
export interface IntakeItem {
  title: string;
  authors?: { name: string; asin?: string | undefined }[] | undefined;
  asin?: string | undefined;
  narrators?: string[] | undefined;
  duration?: number | null | undefined;
  /** Already canonical; callers normalize their own provider-shaped format strings. */
  productionType?: string | null | undefined;
}

export interface IntakeRequest {
  item: IntakeItem;
}

export interface IntakeDeps {
  bookService: Pick<BookService, 'findDuplicate'>;
}

/** A lossless projection of DuplicateResolution. `hasIncumbent` is the only thing separating the
 * two different-recording producers, and the hydrated row carries fields an id cannot. */
export type IntakeDecision =
  | { kind: 'admit'; hasIncumbent: boolean }
  | {
      kind: 'same-recording';
      incumbent: BookWithAuthor | null;
      existingBookId: number | null;
      /** #2435: a fileless incumbent is the record an offered file fulfils, not a duplicate of it.
       * Import-path consumers branch on this; the add-a-book consumers ignore it. */
      incumbentHoldsFile: boolean;
    }
  | {
      kind: 'review';
      incumbent: BookWithAuthor | null;
      existingBookId: number | null;
      recordingReviewReason?: RecordingReviewReason;
    };
