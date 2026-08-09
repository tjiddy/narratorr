import { z } from 'zod';
import { isCompanionEbookExposed } from '../../companion-ebook-exposure.js';
import type { BookStatus } from '../book.js';
import type { CompanionEbookStatus } from '../companion-ebook.js';

// format remains literal because companion_ebooks has no format column and supports only EPUB.
export const companionEbookV1Schema = z
  .object({
    format: z.literal('epub'),
    sizeBytes: z.number(),
  })
  .strict()
  .nullable();

export type CompanionEbookV1 = NonNullable<z.infer<typeof companionEbookV1Schema>>;

export interface CompanionEbookSource {
  status: CompanionEbookStatus;
  sizeBytes: number | null;
}

// DB constraints make null size unreachable for real available rows, but the select type allows it.
export function toCompanionEbookV1(input: {
  enabled: boolean;
  bookStatus: BookStatus;
  observation: CompanionEbookSource | null | undefined;
}): CompanionEbookV1 | null {
  const { enabled, bookStatus, observation } = input;
  if (!isCompanionEbookExposed({ enabled, bookStatus, observationStatus: observation?.status })) {
    return null;
  }
  const sizeBytes = observation?.sizeBytes;
  if (sizeBytes == null) return null;
  return { format: 'epub', sizeBytes };
}
