import { basename } from 'node:path';
import { z } from 'zod';

/**
 * Runtime write boundary for `companion_ebooks`. Variants omit inapplicable fields so callers
 * cannot half-populate a row; the repository alone derives nulls and `selectedFilename`.
 */

/** Validate exact, untrimmed top-level basenames and reject both separators cross-platform. */
const filenameSchema = z
  .string()
  .refine((value) => value.length > 0, { message: 'filename must not be empty' })
  .refine((value) => value.trim() === value, { message: 'filename must not carry leading or trailing whitespace' })
  .refine((value) => !value.includes('/') && !value.includes('\\'), {
    message: 'filename must be a top-level basename, not a path',
  })
  .refine((value) => value !== '.' && value !== '..', { message: 'filename must not be a dot segment' })
  .refine((value) => basename(value) === value, { message: 'filename must be a top-level basename' });

/** Require a safe integer because libSQL cannot read SQLite values beyond JavaScript's safe range. */
const sizeBytesSchema = z.number().nonnegative().transform(Math.trunc).refine(Number.isSafeInteger);

/** Keep pre-1970 timestamps signed and truncate rather than floor to match stored fingerprints. */
const fingerprintTimeSchema = z.number().transform(Math.trunc).refine(Number.isSafeInteger);

const fileFields = {
  filename: filenameSchema,
  sizeBytes: sizeBytesSchema,
  mtimeMs: fingerprintTimeSchema,
  ctimeMs: fingerprintTimeSchema,
  candidateCount: z.number().int().min(1),
  /** The repository derives `selectedFilename` from this flag. */
  selected: z.boolean(),
};

/** Reuse the write-boundary schema so discovery and opening cannot admit unstorable names. */
export function isPersistableCompanionBasename(name: string): boolean {
  return filenameSchema.safeParse(name).success;
}

export const companionEbookObservationSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ status: z.literal('none') }),
    z.strictObject({ status: z.literal('ambiguous'), candidateCount: z.number().int().min(2) }),
    z.strictObject({ status: z.literal('available'), ...fileFields }),
    z.strictObject({ status: z.literal('drm_protected'), ...fileFields }),
    z.strictObject({
      status: z.literal('invalid'),
      ...fileFields,
      validationCode: z.string().trim().min(1),
    }),
  ])
  // Multi-candidate rows must identify the selected file.
  .superRefine((value, ctx) => {
    if (value.status === 'none' || value.status === 'ambiguous') return;
    if (value.candidateCount >= 2 && !value.selected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selected'],
        message: 'A multi-candidate observation must record the selected file',
      });
    }
  });

export type CompanionEbookObservation = z.infer<typeof companionEbookObservationSchema>;
