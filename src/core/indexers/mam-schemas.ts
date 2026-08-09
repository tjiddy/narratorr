import { z } from 'zod';

// MAM emits boolean flags as both JSON booleans and 0/1 integers.
const numericBoolean = z.union([z.boolean(), z.number()])
  .transform((v) => (typeof v === 'number' ? v !== 0 : v));

export const mamSearchResultSchema = z.object({
  id: z.number().nullish(),
  title: z.string().nullish(),
  author_info: z.string().nullish(),
  narrator_info: z.string().nullish(),
  series_info: z.string().nullish(),
  lang_code: z.string().nullish(),
  filetype: z.string().nullish(),
  size: z.union([z.string(), z.number()]).nullish(),
  seeders: z.number().nullish(),
  leechers: z.number().nullish(),
  free: numericBoolean.nullish(),
  fl_vip: numericBoolean.nullish(),
  vip: numericBoolean.nullish(),
  personal_freeleech: numericBoolean.nullish(),
}).passthrough();

// A valid MAM response has data or error; reject interstitials and shape changes.
export const mamSearchResponseSchema = z.object({
  error: z.string().nullish(),
  data: z.array(mamSearchResultSchema).nullish(),
}).passthrough().refine(
  (d) => d.error != null || d.data != null,
  { message: 'MAM search response missing both "data" and "error" fields' },
);

export const mamUserStatusSchema = z.object({
  username: z.string().nullish(),
  classname: z.string().nullish(),
  wedges: z.number().nullish(),
}).passthrough();

export type MAMSearchResult = z.infer<typeof mamSearchResultSchema>;
export type MAMUserStatus = z.infer<typeof mamUserStatusSchema>;
