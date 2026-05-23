import { z } from 'zod';

// MAM (and many PHP-backend APIs) emit boolean flag fields as 0/1 integers
// rather than JSON booleans. Accept both shapes and normalize to boolean.
const numericBoolean = z.union([z.boolean(), z.number()])
  .transform((v) => (typeof v === 'number' ? v !== 0 : v));

export const mamSearchResultSchema = z.object({
  id: z.number().nullish(),
  title: z.string().nullish(),
  author_info: z.string().nullish(),
  narrator_info: z.string().nullish(),
  series_info: z.string().nullish(),
  lang_code: z.string().nullish(),
  size: z.union([z.string(), z.number()]).nullish(),
  seeders: z.number().nullish(),
  leechers: z.number().nullish(),
  free: numericBoolean.nullish(),
  fl_vip: numericBoolean.nullish(),
  vip: numericBoolean.nullish(),
  personal_freeleech: numericBoolean.nullish(),
}).passthrough();

// MAM search responses always carry either `data` (results array, possibly empty)
// or `error` (a message). A response with neither is malformed (e.g. HTML
// interstitial, rate-limit page, upstream API change) and must fail validation
// rather than silently producing an empty result list.
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
