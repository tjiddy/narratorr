import { z } from 'zod';
import { INDEXER_REGISTRY, INDEXER_TYPES, type IndexerType, type MamSearchType } from '../indexer-registry';
import { normalizeBaseUrl } from '../normalize-base-url.js';

export const indexerTypeSchema = z.enum(INDEXER_TYPES);

const apiKeySettingsFields = {
  apiUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  flareSolverrUrl: z.string().optional(),
  useProxy: z.boolean().optional(),
};

export const newznabSettingsSchema = z.object(apiKeySettingsFields).strict();
export const torznabSettingsSchema = z.object(apiKeySettingsFields).strict();

const mamSearchTypeServerSchema = z.union([
  z.enum(['all', 'active', 'fl', 'fl-VIP', 'VIP', 'nVIP']),
  z.number().int().min(0).max(3).transform((n): MamSearchType => {
    const map: Record<number, MamSearchType> = { 0: 'all', 1: 'active', 2: 'fl', 3: 'fl-VIP' };
    return map[n]!;
  }),
]);

export const wedgeModeSchema = z.enum(['never', 'preferred']);
export type WedgeMode = z.infer<typeof wedgeModeSchema>;

export const mamSettingsSchema = z.object({
  mamId: z.string().trim().min(1),
  baseUrl: z.string().trim().optional(),
  searchLanguages: z.array(z.number()).optional(),
  searchType: mamSearchTypeServerSchema.optional(),
  isVip: z.boolean().optional(),
  mamUsername: z.string().optional(),
  classname: z.string().optional(),
  useProxy: z.boolean().optional(),
  flareSolverrUrl: z.string().optional(),
  useFreeleechWedge: wedgeModeSchema.default('never'),
}).strict();

export const ABB_HOSTNAME_MESSAGE = 'Must be a valid hostname';

// A bare `host:port` parses as scheme `host:` with an empty host, so a colon followed by digits is
// a port, not a scheme (#2392) — without this, `audiobookbay.lu:8080` reads as a rejected scheme.
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*(:\/\/|:(?!\d))/i;
const HTTP_SCHEME_PREFIX = /^https?:\/\//i;

/**
 * Reduce whatever the operator typed into the bare host `ABBConfig` composes `https://${…}` from,
 * or `null` when it cannot be. Re-parsing under `https://` is what elides an explicit `:443` while
 * keeping every other port, and what yields punycode for an IDN. Exported for `pnpm exec tsx`.
 */
export function normalizeAbbHostname(raw: string): string | null {
  const trimmed = raw.trim();
  const scheme = EXPLICIT_SCHEME.test(trimmed);
  if (scheme && !HTTP_SCHEME_PREFIX.test(trimmed)) return null;
  const withoutScheme = scheme ? trimmed.replace(HTTP_SCHEME_PREFIX, '') : trimmed;

  let url: URL;
  try {
    url = new URL(`https://${withoutScheme}`);
  } catch {
    return null;
  }
  // Userinfo is dropped silently by the parser, so an operator who typed it meant something the
  // stored value would not do.
  if (url.username !== '' || url.password !== '') return null;
  if (!/[a-z0-9]/i.test(url.host)) return null;
  return url.host;
}

const abbHostnameSchema = z.string().transform((value, ctx) => {
  const host = normalizeAbbHostname(value);
  if (host === null) {
    ctx.addIssue({ code: 'custom', message: ABB_HOSTNAME_MESSAGE });
    return z.NEVER;
  }
  return host;
});

export const abbSettingsSchema = z.object({
  hostname: abbHostnameSchema,
  pageLimit: z.number().int().min(1).max(10).optional(),
  flareSolverrUrl: z.string().optional(),
  useProxy: z.boolean().optional(),
}).strict();

export type NewznabSettings = z.infer<typeof newznabSettingsSchema>;
export type TorznabSettings = z.infer<typeof torznabSettingsSchema>;
// z.input keeps defaulted wedge settings optional to callers; parsing materializes them.
export type MamSettings = z.input<typeof mamSettingsSchema>;
export type AbbSettings = z.infer<typeof abbSettingsSchema>;

export type IndexerSettingsMap = {
  newznab: NewznabSettings;
  torznab: TorznabSettings;
  myanonamouse: MamSettings;
  abb: AbbSettings;
};

export type IndexerSettings = IndexerSettingsMap[IndexerType];

export const indexerSettingsSchemas: Record<IndexerType, z.ZodTypeAny> = {
  newznab: newznabSettingsSchema,
  torznab: torznabSettingsSchema,
  myanonamouse: mamSettingsSchema,
  abb: abbSettingsSchema,
};

function validateSettingsPerType(
  data: { type: string; settings: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  const schema = indexerSettingsSchemas[data.type as IndexerType];
  if (!schema) return;
  const result = schema.safeParse(data.settings);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['settings', ...issue.path] });
    }
  } else {
    data.settings = result.data as Record<string, unknown>;
  }
}

export const createIndexerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateSettingsPerType);

export const updateIndexerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: indexerTypeSchema.optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
  if (data.settings !== undefined && !data.type) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Type is required when settings are provided' });
    return;
  }
  if (data.settings !== undefined && data.type) {
    validateSettingsPerType(data as { type: string; settings: Record<string, unknown> }, ctx);
  }
});

export const createIndexerFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    hostname: z.string().optional(),
    pageLimit: z.number().int().min(1).max(10).optional(),
    apiUrl: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    flareSolverrUrl: z.string().optional(),
    mamId: z.string().optional(),
    baseUrl: z.string().trim().optional(),
    useProxy: z.boolean().optional(),
    searchLanguages: z.array(z.number()).optional(),
    searchType: z.enum(['all', 'active', 'fl', 'fl-VIP', 'VIP', 'nVIP']).optional(),
    isVip: z.boolean().optional(),
    mamUsername: z.string().optional(),
    classname: z.string().optional(),
    useFreeleechWedge: wedgeModeSchema.optional(),
  }),
}).superRefine((data, ctx) => {
  const meta = INDEXER_REGISTRY[data.type];
  if (meta) {
    for (const field of meta.requiredFields) {
      const value = data.settings[field.path as keyof typeof data.settings];
      if (!value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
      }
    }
  }

  // Validation only — the server schema stays the single normalizer, because a `.transform()` here
  // would diverge the form's input and output types and mistype `zodResolver`.
  const hostname = data.settings.hostname?.trim();
  if (data.type === 'abb' && hostname && normalizeAbbHostname(hostname) === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'hostname'], message: ABB_HOSTNAME_MESSAGE });
  }

  const proxyUrl = normalizeBaseUrl(data.settings.flareSolverrUrl)?.trim();
  if (proxyUrl === '********') {
    // Preserve the masked secret sentinel.
  } else if (proxyUrl) {
    try {
      new URL(proxyUrl);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'flareSolverrUrl'], message: 'Must be a valid URL' });
    }
    data.settings.flareSolverrUrl = proxyUrl;
  } else {
    data.settings.flareSolverrUrl = undefined;
  }
});

export type CreateIndexerFormData = z.infer<typeof createIndexerFormSchema>;
