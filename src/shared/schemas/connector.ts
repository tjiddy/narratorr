import { z } from 'zod';
import { CONNECTOR_REGISTRY, CONNECTOR_TYPES, type ConnectorType } from '../connector-registry';

// ============================================================================
// Connector schemas
// ============================================================================

export const connectorTypeSchema = z.enum(CONNECTOR_TYPES);

// ── Per-adapter settings schemas (strict — rejects unknown fields) ──────────

export const audiobookshelfSettingsSchema = z.object({
  baseUrl: z.string().trim().min(1),
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
  baseUrl: z.string().trim().min(1),
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
) {
  const schema = connectorSettingsSchemas[data.type as ConnectorType];
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

export const updateConnectorSchema = z.object({
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
    validateSettingsPerType(data as { type: string; settings: Record<string, unknown> }, ctx);
  }
});

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
    pathMappings: z.array(z.object({
      localPath: z.string(),
      serverPath: z.string(),
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
