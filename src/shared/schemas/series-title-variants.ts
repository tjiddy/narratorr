import { z } from 'zod';

// ============================================================================
// Title-variant contract — canonical source for the variant shape the series
// member matcher pairs on (#2096). The GENERATOR lives in
// `src/core/utils/title-variants.ts`; only the type contract lives here.
//
// Why shared owns it: `src/core/**` may import `src/shared/**`, but
// `src/shared/**` may NOT import `src/core/**` (eslint.config.js). Declaring the
// type in core would force a second, structurally-duplicated definition here for
// the debug-route response schema. Declaring it here and letting core re-export
// is the established repo answer to exactly this constraint — the same
// arrangement `recording-verdict.ts` ↔ `recording-identity.ts:25,35` uses.
// ============================================================================

/**
 * Which slice of the title a variant represents.
 *
 *  - `full`            — the whole (normalized) title.
 *  - `first+last`      — the first and last colon segments, dropping the middle.
 *                        Covers the deep-franchise case
 *                        (`"Star Wars: The High Republic: Light of the Jedi"`
 *                        against a library `"Star Wars: Light of the Jedi"`).
 *  - `prefix(n)`       — the first `n` colon segments RETAINED.
 *  - `suffix(n)`       — the last `n` colon segments RETAINED.
 *
 * Declared as a type-NARROWING union (literals + template literals), not a regex
 * refinement: `z.string().regex(...)` infers `string`, which would degenerate
 * `VariantTag` and defeat the whole point of deriving the type from the schema.
 *
 * Numeric domain (deliberate): `${number}` — and therefore this schema — admits
 * `prefix(1.5)`, `prefix(-2)` and `prefix(0)`; only malformed SHAPES
 * (`prefix()`, `prefix(x)`, `middle(1)`, `prefix( 2 )`, wrong case, stray
 * whitespace) are rejected. Do NOT tighten to `\d+`: that reintroduces exactly
 * the schema/type divergence this file exists to prevent. That `n` is always a
 * positive integer is a GENERATOR invariant, pinned in
 * `src/core/utils/title-variants.test.ts`.
 */
export const variantTagSchema = z.union([
  z.literal('full'),
  z.literal('first+last'),
  z.templateLiteral(['prefix(', z.number(), ')']),
  z.templateLiteral(['suffix(', z.number(), ')']),
]);
export type VariantTag = z.infer<typeof variantTagSchema>;

/**
 * One generated title variant. `raw` carries the NORMALIZED text for that slice
 * (already lowercased, diacritic-folded and whitespace-collapsed), so it doubles
 * as the case-insensitive collapsed dedup key. `parensStripped` records whether
 * the variant was derived from the paren-stripped base — every colon-derived
 * variant is, by construction (G1).
 *
 * `lossy` (#2110) records whether THIS slice lost identity-bearing characters to
 * the ASCII fold — the same character-survival question `hasDegenerateFullForm`
 * asks of a whole title, asked per slice. The pairing rule refuses a lossy
 * variant as offered evidence, so a fragment whose distinguishing content the
 * fold ate can never claim another book.
 */
export const variantSchema = z.object({
  raw: z.string(),
  tag: variantTagSchema,
  parensStripped: z.boolean(),
  lossy: z.boolean(),
});
export type Variant = z.infer<typeof variantSchema>;

// ============================================================================
// POST /api/series/title-variants-debug — the parse tester for the member
// matcher, mirroring `POST /api/library/scan-debug` for folder names.
// ============================================================================

/** Same bounds as `scanDebugBodySchema` (`library-scan.ts`). */
export const titleVariantsDebugBodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required and must be a non-empty string')
    .max(1024, 'title must be at most 1024 characters'),
});
export type TitleVariantsDebugBody = z.infer<typeof titleVariantsDebugBodySchema>;

/**
 * A NAMED wrapper, not a bare array. `full` is surfaced explicitly alongside the
 * variants because the title-path acceptance rule keys on it (a DERIVED variant
 * may only equal the other side's FULL form), so one response per side is enough
 * to diagnose a pairing.
 */
export const titleVariantsDebugResponseSchema = z.object({
  input: z.string(),
  full: z.string(),
  variants: z.array(variantSchema),
});
export type TitleVariantsDebugResponse = z.infer<typeof titleVariantsDebugResponseSchema>;
