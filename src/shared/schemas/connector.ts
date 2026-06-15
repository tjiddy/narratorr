import { z } from 'zod';
import { CONNECTOR_REGISTRY, CONNECTOR_TYPES, type ConnectorType } from '../connector-registry';

// ============================================================================
// Connector schemas
// ============================================================================

export const connectorTypeSchema = z.enum(CONNECTOR_TYPES);

// ── Shared baseUrl validation + normalization ───────────────────────────────

/**
 * Parse a connector `baseUrl`, enforce an http(s) origin, reject query/fragment,
 * and normalize to `scheme://host[:port][/path]` with no trailing slash. Returns
 * `null` for any value that is not a usable HTTP(S) base (malformed, schemeless,
 * non-http(s), or carrying a search/hash).
 *
 * Private/LAN/Docker hosts and IPs are intentionally accepted — only the URL
 * scheme/shape is constrained, never the address (no SSRF blocking; see
 * SECURITY.md / #769/#877/#885). This is trust-boundary input hardening so a
 * typo fails at save time instead of leaving a permanently-failing connector.
 */
function normalizeConnectorBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * `baseUrl` field schema: validates + normalizes in one transform so the
 * normalized origin is persisted at the schema layer (not only at adapter
 * runtime). Emits a `baseUrl`-scoped error on any non-http(s) / malformed /
 * query- or hash-bearing value. Rejects the masked `'********'` secret sentinel
 * (it is not a valid URL) — that is deliberate: the sentinel is admitted only on
 * the update/test/targets paths, which wrap this schema in a sentinel union (see
 * `loosenSettingsSchema` in secret-codec.ts).
 */
export const connectorBaseUrlSchema = z.string().trim().transform((val, ctx) => {
  const normalized = normalizeConnectorBaseUrl(val);
  if (normalized === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must be a valid http(s) URL with no query string or fragment',
    });
    return z.NEVER;
  }
  return normalized;
});

// ── Per-adapter settings schemas (strict — rejects unknown fields) ──────────

export const audiobookshelfSettingsSchema = z.object({
  baseUrl: connectorBaseUrlSchema,
  // Sentinel passthrough: apiKey is a registered secret, so the masked '********'
  // must survive validation on create/update. It does so because this is a bare
  // `.trim().min(1)` (the sentinel is 8 non-space chars). Any future format
  // constraint must explicitly admit the sentinel literal — see notifier.ts.
  apiKey: z.string().trim().min(1),
  libraryId: z.string().trim().min(1),
}).strict();

export const plexPathMappingSchema = z.object({
  localPath: z.string().trim().min(1),
  serverPath: z.string().trim().min(1),
}).strict();

export const plexSettingsSchema = z.object({
  baseUrl: connectorBaseUrlSchema,
  // token is a registered connector secret — bare `.trim().min(1)` admits the
  // masked '********' sentinel on create/update (same rationale as apiKey above).
  token: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
  // Connector-scoped path mapping (narratorr local → Plex server). Default [] so
  // a passthrough-only connector validates; longest-prefix resolution at runtime.
  pathMappings: z.array(plexPathMappingSchema).default([]),
  fallbackToFullRefresh: z.boolean().default(false),
}).strict();

// ── Settings types and dispatch map ─────────────────────────────────────────

export type AudiobookshelfSettings = z.infer<typeof audiobookshelfSettingsSchema>;
export type PlexSettings = z.infer<typeof plexSettingsSchema>;

export type ConnectorSettingsMap = {
  audiobookshelf: AudiobookshelfSettings;
  plex: PlexSettings;
};

export type ConnectorSettings = ConnectorSettingsMap[ConnectorType];

export const connectorSettingsSchemas: Record<ConnectorType, z.ZodTypeAny> = {
  audiobookshelf: audiobookshelfSettingsSchema,
  plex: plexSettingsSchema,
};

// ── Server-side schemas ─────────────────────────────────────────────────────

function validateSettingsPerType(
  data: { type: string; settings: Record<string, unknown> },
  ctx: z.RefinementCtx,
  schemas: Record<string, z.ZodTypeAny> = connectorSettingsSchemas,
) {
  const schema = schemas[data.type];
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

export const createConnectorSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: connectorTypeSchema,
  enabled: z.boolean().default(true),
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateSettingsPerType);

/**
 * Build the connector update schema against a given per-type settings map. The
 * default map (`connectorSettingsSchemas`) is strict — it rejects the masked
 * `'********'` secret sentinel on `baseUrl`. The PUT route passes a
 * sentinel-loosened map instead so masked `baseUrl`/`apiKey`/`token` edits
 * survive (see `src/server/routes/connectors.ts`). Validation of real
 * (non-sentinel) values is identical either way.
 */
export function makeUpdateConnectorSchema(
  settingsSchemas: Record<string, z.ZodTypeAny> = connectorSettingsSchemas,
) {
  return z.object({
    name: z.string().trim().min(1).max(100).optional(),
    type: connectorTypeSchema.optional(),
    enabled: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }).superRefine((data, ctx) => {
    if (data.settings !== undefined && !data.type) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Type is required when settings are provided' });
      return;
    }
    if (data.settings !== undefined && data.type) {
      validateSettingsPerType(data as { type: string; settings: Record<string, unknown> }, ctx, settingsSchemas);
    }
  });
}

export const updateConnectorSchema = makeUpdateConnectorSchema();

export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;

// ── Form schema (superRefine + registry.requiredFields for zodResolver compat) ──

export const createConnectorFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: connectorTypeSchema,
  enabled: z.boolean(),
  settings: z.object({
    // Audiobookshelf
    baseUrl: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    libraryId: z.string().trim().optional(),
    // Plex
    token: z.string().trim().optional(),
    sectionId: z.string().trim().optional(),
    // `.trim().min(1)` mirrors the server's plexPathMappingSchema so zodResolver
    // produces per-row field errors at settings.pathMappings.${i}.{localPath,serverPath}
    // for partial rows (one side filled). Fully-blank rows are pruned before the
    // resolver runs (see ConnectorCardForm), so they never reach this check.
    // (CLAUDE.md gotcha: bare .min(1) accepts whitespace — use .trim().min(1).)
    pathMappings: z.array(z.object({
      localPath: z.string().trim().min(1, 'Local path is required'),
      serverPath: z.string().trim().min(1, 'Server path is required'),
    })).optional(),
    fallbackToFullRefresh: z.boolean().optional(),
  }),
}).superRefine((data, ctx) => {
  const meta = CONNECTOR_REGISTRY[data.type];
  if (!meta) return;
  for (const field of meta.requiredFields) {
    if (!data.settings[field.path as keyof typeof data.settings]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
    }
  }
});

export type CreateConnectorFormData = z.infer<typeof createConnectorFormSchema>;
