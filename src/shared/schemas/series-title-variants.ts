import { z } from 'zod';

// Shared owns this contract because core may depend on shared, not vice versa;
// the generator lives in core/utils/title-variants.ts.
// first+last drops interior colon segments; prefix(n)/suffix(n) retain n segments.
// Deliberately matches `${number}`, including zero/fractions/negatives; the generator
// alone enforces positive integers.
export const variantTagSchema = z.union([
  z.literal('full'),
  z.literal('first+last'),
  z.templateLiteral(['prefix(', z.number(), ')']),
  z.templateLiteral(['suffix(', z.number(), ')']),
]);
export type VariantTag = z.infer<typeof variantTagSchema>;

// raw is normalized and doubles as the dedup key. lossy marks slices that lost
// identity-bearing characters during ASCII folding and cannot establish a match.
export const variantSchema = z.object({
  raw: z.string(),
  tag: variantTagSchema,
  parensStripped: z.boolean(),
  lossy: z.boolean(),
});
export type Variant = z.infer<typeof variantSchema>;

// Supplying other requests pair analysis as well as title variants.
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

/** Everything the acceptance rule keys on for one side. full alone is insufficient:
 * lossless and degenerateFull prevent false matches when non-ASCII subtitles fold away. */
export const titleVariantsDebugSideSchema = z.object({
  input: z.string(),
  full: z.string(),
  lossless: z.string(),
  degenerateFull: z.boolean(),
  variants: z.array(variantSchema),
});
export type TitleVariantsDebugSide = z.infer<typeof titleVariantsDebugSideSchema>;

// The ordered rule is implemented only by explainShapePairing in
// server/services/series-title-match.ts.
export const titlePairArmSchema = z.union([
  z.literal('full-equals-full'),
  z.literal('derived-equals-full'),
  z.literal('lossless-equals-lossless'),
  z.literal('none'),
]);
export type TitlePairArm = z.infer<typeof titlePairArmSchema>;

// pairs must equal (arm !== 'none'); reason is explanatory prose, not a stable sentence.
export const titlePairVerdictSchema = z.object({
  pairs: z.boolean(),
  arm: titlePairArmSchema,
  reason: z.string().min(1),
});
export type TitlePairVerdict = z.infer<typeof titlePairVerdictSchema>;

// comparison is omitted when the request omits other.
export const titleVariantsDebugResponseSchema = titleVariantsDebugSideSchema.extend({
  comparison: titlePairVerdictSchema.extend({ other: titleVariantsDebugSideSchema }).optional(),
});
export type TitleVariantsDebugResponse = z.infer<typeof titleVariantsDebugResponseSchema>;
