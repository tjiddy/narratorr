import { z } from 'zod';
import { CONNECTOR_REGISTRY, CONNECTOR_TYPES, type ConnectorType } from '../connector-registry';

export const connectorTypeSchema = z.enum(CONNECTOR_TYPES);

// Private, LAN, Docker, and IP hosts remain valid; this checks URL shape, not SSRF.
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

// The base schema rejects masked secrets; update/test/targets explicitly loosen it.
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

export const audiobookshelfSettingsSchema = z.object({
  baseUrl: connectorBaseUrlSchema,
  // Any future format constraint must admit the masked secret sentinel.
  apiKey: z.string().trim().min(1),
  libraryId: z.string().trim().min(1),
}).strict();

export const plexPathMappingSchema = z.object({
  localPath: z.string().trim().min(1),
  serverPath: z.string().trim().min(1),
}).strict();

export const plexSettingsSchema = z.object({
  baseUrl: connectorBaseUrlSchema,
  // Any future format constraint must admit the masked secret sentinel.
  token: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
  pathMappings: z.array(plexPathMappingSchema).default([]),
  fallbackToFullRefresh: z.boolean().default(false),
}).strict();

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

// Target discovery cannot require the selector it is meant to populate; strict
// create/update/test validation still requires it.
export const CONNECTOR_SELECTOR_FIELDS: Record<ConnectorType, string> = {
  audiobookshelf: 'libraryId',
  plex: 'sectionId',
};

// safeExtend preserves the base schema's strictness and refinements.
function makeTargetsSettingsSchema(schema: z.ZodTypeAny, selectorField: string): z.ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const obj = schema as z.ZodObject<z.ZodRawShape>;
  if (!(obj.shape as Record<string, z.ZodTypeAny>)[selectorField]) return schema;
  return obj.safeExtend({ [selectorField]: z.string().trim().default('') });
}

export const connectorTargetsSettingsSchemas: Record<ConnectorType, z.ZodTypeAny> = Object.fromEntries(
  CONNECTOR_TYPES.map((type) => [
    type,
    makeTargetsSettingsSchema(connectorSettingsSchemas[type], CONNECTOR_SELECTOR_FIELDS[type]),
  ]),
) as Record<ConnectorType, z.ZodTypeAny>;

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

// Routes that round-trip masked secrets inject a loosened map; real values use
// the same validation as the strict default map.
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

export const createConnectorFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: connectorTypeSchema,
  enabled: z.boolean(),
  settings: z.object({
    baseUrl: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    libraryId: z.string().trim().optional(),
    token: z.string().trim().optional(),
    sectionId: z.string().trim().optional(),
    // ConnectorCardForm prunes blank rows; reject partial or whitespace-only rows here.
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
