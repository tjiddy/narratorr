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

/**
 * Same bounds as `scanDebugBodySchema` (`library-scan.ts`). `other` is optional
 * and carries the IDENTICAL bounds — supplying it turns the endpoint from "what
 * does this title reduce to" into "would these two pair, and why".
 */
export const titleVariantsDebugBodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required and must be a non-empty string')
    .max(1024, 'title must be at most 1024 characters'),
  other: z
    .string()
    .trim()
    .min(1, 'other must be a non-empty string when provided')
    .max(1024, 'other must be at most 1024 characters')
    .optional(),
});
export type TitleVariantsDebugBody = z.infer<typeof titleVariantsDebugBodySchema>;

/**
 * Everything the acceptance rule keys on for ONE side.
 *
 * `full` alone is not enough and never was: the rule also consults
 * `degenerateFull` and `lossless`, so a response carrying only `full` +
 * `variants` let an operator hand-apply a rule the matcher does not implement
 * and reach the OPPOSITE conclusion — on precisely the hardest-to-eyeball class
 * (two franchise siblings whose non-Latin subtitles both fold away, so both
 * sides report `full: 'world of warcraft'`). That is the #2110 finding; these
 * five fields are its fix.
 */
export const titleVariantsDebugSideSchema = z.object({
  input: z.string(),
  full: z.string(),
  lossless: z.string(),
  degenerateFull: z.boolean(),
  variants: z.array(variantSchema),
});
export type TitleVariantsDebugSide = z.infer<typeof titleVariantsDebugSideSchema>;

/**
 * Which branch of the ordered acceptance rule decided a pairing. Declared HERE,
 * in shared, because both the server-side rule and the debug-route response
 * need it and `src/shared/**` may not import `src/server/**`.
 *
 * The rule, in evaluation order — this file used to describe it as "FULL≡FULL,
 * or one side's DERIVED variant equalling the other's FULL", which omits the
 * degeneracy, lossy and empty-form conditions the matcher actually applies and
 * therefore predicts MATCH where production refuses (#2110):
 *
 *   1. both FULL forms empty, both lossless non-empty and equal
 *                                                      → `lossless-equals-lossless`
 *   2. both FULL forms empty, otherwise                 → `none`
 *   3. exactly one FULL form empty                      → `none`
 *   4. FULLs equal, neither side degenerate             → `full-equals-full`
 *   5. FULLs equal, either degenerate, lossless equal   → `full-equals-full`
 *   6. FULLs equal, either degenerate, lossless differ  → `none`
 *   7. FULLs differ, some non-lossy DERIVED variant of one side equals the
 *      other side's FULL, and that other side is not degenerate
 *                                                       → `derived-equals-full`
 *   8. otherwise                                        → `none`
 *
 * Its single implementation home is `explainShapePairing`
 * (`src/server/services/series-title-match.ts`); nothing else may re-implement
 * it.
 *
 * No drift guard watches this one (unlike `Variant` / `VariantTag`): the
 * server's `explainShapePairing` is ANNOTATED with the inferred
 * `TitlePairVerdict`, so divergence is a typecheck error at the definition site
 * and a guard could never be the failing observation — the inverse of the
 * reasoning documented in `series-title-variants.test.ts`.
 */
export const titlePairArmSchema = z.union([
  z.literal('full-equals-full'),
  z.literal('derived-equals-full'),
  z.literal('lossless-equals-lossless'),
  z.literal('none'),
]);
export type TitlePairArm = z.infer<typeof titlePairArmSchema>;

/**
 * The production verdict for one pair. `pairs === (arm !== 'none')` always;
 * `reason` is human-readable prose naming the FULL forms compared (rendered
 * `(empty)` when a FULL form is `''`) plus whatever the deciding branch keyed
 * on. It is deliberately unpinned as an exact sentence — tests assert its
 * CONTENT.
 */
export const titlePairVerdictSchema = z.object({
  pairs: z.boolean(),
  arm: titlePairArmSchema,
  reason: z.string().min(1),
});
export type TitlePairVerdict = z.infer<typeof titlePairVerdictSchema>;

/**
 * A NAMED wrapper, not a bare array. The five per-side fields stay TOP-LEVEL, so
 * the single-title response this endpoint has always returned is a strict SUBSET
 * of this shape and `comparison` is the only new key. `comparison` is absent —
 * not `null` — when the request omits `other`.
 */
export const titleVariantsDebugResponseSchema = titleVariantsDebugSideSchema.extend({
  comparison: titlePairVerdictSchema.extend({ other: titleVariantsDebugSideSchema }).optional(),
});
export type TitleVariantsDebugResponse = z.infer<typeof titleVariantsDebugResponseSchema>;
