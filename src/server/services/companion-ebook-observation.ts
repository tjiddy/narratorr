import { basename } from 'node:path';
import { z } from 'zod';

/**
 * The write boundary for `companion_ebooks` (#1958, plan §2) — a shape union PLUS a value
 * validator, because types alone cannot carry this contract. TypeScript can express "these
 * fields exist together"; it cannot express `candidateCount >= 2`, integer-ness,
 * `selectedFilename === filename`, or "this string is a basename".
 *
 * Three shape choices remove whole classes of invalid state rather than validating them:
 * - **The caller never supplies a null.** `none` and `ambiguous` carry no file fields, no
 *   `validationCode`, and no selection field at all; the repository writes those columns as
 *   `null` itself, so a caller cannot half-set a row.
 * - **`none` has no `candidateCount`** — it is always `0`, written by the repository.
 * - **The caller never supplies `selectedFilename`.** The variant carries `selected: boolean`
 *   and the repository writes `selectedFilename = selected ? filename : null`, so
 *   `ck_companion_ebooks_selection`'s equality holds *structurally* — a mismatch is not
 *   expressible.
 */

/**
 * A validated top-level basename — **validated, never normalised**. `src/db/schema.ts`
 * documents the invariant and the table carries no CHECK for it, so this is the only
 * boundary that can hold it.
 *
 * Every rule below is a non-mutating predicate; there is deliberately no `.trim()`. A stored
 * basename must still resolve against the real directory entry, and silently trimming
 * `' book.epub '` would persist a name that no longer names the file. A padded value is an
 * upstream bug (`readdir` returns exact entries), so it is rejected, not repaired.
 * (`validationCode` is the opposite case — a code literal, so it *does* use `.trim().min(1)`.)
 *
 * Both separators are refused on every platform: a POSIX server must still reject a
 * Windows-authored `sub\file.epub`, which `basename()` alone would happily accept there.
 */
const filenameSchema = z
  .string()
  .refine((value) => value.length > 0, { message: 'filename must not be empty' })
  .refine((value) => value.trim() === value, { message: 'filename must not carry leading or trailing whitespace' })
  .refine((value) => !value.includes('/') && !value.includes('\\'), {
    message: 'filename must be a top-level basename, not a path',
  })
  .refine((value) => value !== '.' && value !== '..', { message: 'filename must not be a dot segment' })
  .refine((value) => basename(value) === value, { message: 'filename must be a top-level basename' });

/**
 * `size_bytes`: nonnegative, truncated toward zero, then range-checked.
 *
 * The refinement is `Number.isSafeInteger`, not an int64 range check, because a *finite,
 * integral, oversized* value survives truncation and fails in one of two ways: `1e20` binds
 * as REAL and trips `ck_companion_ebooks_fingerprint` on write, while `2**53` (above
 * `MAX_SAFE_INTEGER`, inside int64) **writes successfully** and then makes every later read
 * of that row throw `Received integer which cannot be safely represented as a JavaScript
 * number`. The second band is the worse one, and only a safe-integer bound closes it.
 *
 * `z.number()` already rejects `NaN`/`Infinity`/`-Infinity` in the pinned Zod 4.4.1, so
 * `.finite()` would be redundant here.
 */
const sizeBytesSchema = z.number().nonnegative().transform(Math.trunc).refine(Number.isSafeInteger);

/**
 * `mtime_ms` / `ctime_ms`: **signed on purpose** — `src/db/schema.ts`'s own comment keeps a
 * user-preserved pre-1970 mtime legitimate — then truncated and range-checked as above.
 *
 * The normalisation is `Math.trunc` and nothing else. `Math.floor` is NOT interchangeable:
 * the two agree on positive values but diverge across the signed domain this schema
 * deliberately admits (`Math.trunc(-123.75) === -123`, `Math.floor(-123.75) === -124`).
 * `src/db/schema.ts` fixes the choice, and 1.2c's fingerprint short-circuit compares against
 * rows written through here — a floor would silently desynchronise it.
 */
const fingerprintTimeSchema = z.number().transform(Math.trunc).refine(Number.isSafeInteger);

const fileFields = {
  filename: filenameSchema,
  sizeBytes: sizeBytesSchema,
  mtimeMs: fingerprintTimeSchema,
  ctimeMs: fingerprintTimeSchema,
  /** At least one candidate exists whenever a file was resolved. */
  candidateCount: z.number().int().min(1),
  /** Whether this file is the owner's pick; the repository derives `selectedFilename` from it. */
  selected: z.boolean(),
};

/**
 * True when `name` is a basename the observation write boundary will accept (#1974 AC10).
 *
 * Defined *from* `filenameSchema` rather than restating its rules, so candidate discovery
 * (`companion-ebook-discovery.ts`), the open-and-verify helper (`companion-ebook-open.ts`),
 * and this write boundary share one domain **by construction** and cannot drift. Without it,
 * discovery on Alpine could emit a legal-on-POSIX ` book.epub` or `sub\book.epub` that nothing
 * downstream can store or open.
 *
 * Validates, never normalises: a rejected entry is skipped, not repaired — a trimmed name no
 * longer names the real directory entry.
 */
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
  // The one rule the variants cannot express: a row that resolved to one file while more
  // than one candidate is still on disk must record whose pick it was
  // (`ck_companion_ebooks_multi_candidate_selection`).
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
