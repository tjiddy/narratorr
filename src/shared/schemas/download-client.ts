import { z } from 'zod';
import { DOWNLOAD_CLIENT_REGISTRY, DOWNLOAD_CLIENT_TYPES, type DownloadClientType } from '../download-client-registry';
import { protocolSchema } from './download-protocol';

export const downloadClientTypeSchema = z.enum(DOWNLOAD_CLIENT_TYPES);

const hostPortSettingsFields = {
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  useSsl: z.boolean().optional(),
};

export const qbittorrentSettingsSchema = z.object({
  ...hostPortSettingsFields,
  username: z.string().trim().optional(),
  password: z.string().trim().optional(),
  category: z.string().trim().optional(),
}).strict();

export const transmissionSettingsSchema = z.object({
  ...hostPortSettingsFields,
  username: z.string().trim().optional(),
  password: z.string().trim().optional(),
  category: z.string().trim().optional(),
}).strict();

export const sabnzbdSettingsSchema = z.object({
  ...hostPortSettingsFields,
  apiKey: z.string().trim().min(1),
  category: z.string().trim().optional(),
}).strict();

export const nzbgetSettingsSchema = z.object({
  ...hostPortSettingsFields,
  username: z.string().trim().optional(),
  password: z.string().trim().optional(),
  category: z.string().trim().optional(),
}).strict();

export const delugeSettingsSchema = z.object({
  ...hostPortSettingsFields,
  password: z.string().trim().optional(),
  category: z.string().trim().optional(),
}).strict();

export const blackholeSettingsSchema = z.object({
  watchDir: z.string().trim().min(1),
  protocol: protocolSchema,
}).strict();

export type QBittorrentSettings = z.infer<typeof qbittorrentSettingsSchema>;
export type TransmissionSettings = z.infer<typeof transmissionSettingsSchema>;
export type SABnzbdSettings = z.infer<typeof sabnzbdSettingsSchema>;
export type NZBGetSettings = z.infer<typeof nzbgetSettingsSchema>;
export type DelugeSettings = z.infer<typeof delugeSettingsSchema>;
export type BlackholeSettings = z.infer<typeof blackholeSettingsSchema>;

export type DownloadClientSettingsMap = {
  qbittorrent: QBittorrentSettings;
  transmission: TransmissionSettings;
  sabnzbd: SABnzbdSettings;
  nzbget: NZBGetSettings;
  deluge: DelugeSettings;
  blackhole: BlackholeSettings;
};

export type DownloadClientSettings = DownloadClientSettingsMap[DownloadClientType];

/**
 * The single home for the category decision (#2433). Takes an unvalidated settings record too —
 * download.service reads the decrypted row without a Zod parse, so a non-string must yield
 * undefined rather than throw.
 */
export function clientCategory(
  settings: Record<string, unknown> | DownloadClientSettings | null | undefined,
): string | undefined {
  const raw = (settings as Record<string, unknown> | null | undefined)?.['category'];
  return typeof raw === 'string' ? raw.trim() || undefined : undefined;
}

export const downloadClientSettingsSchemas: Record<DownloadClientType, z.ZodTypeAny> = {
  qbittorrent: qbittorrentSettingsSchema,
  transmission: transmissionSettingsSchema,
  sabnzbd: sabnzbdSettingsSchema,
  nzbget: nzbgetSettingsSchema,
  deluge: delugeSettingsSchema,
  blackhole: blackholeSettingsSchema,
};

function validateSettingsPerType(
  data: { type: string; settings: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  const schema = downloadClientSettingsSchemas[data.type as DownloadClientType];
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

// Create payload entries omit downloadClientId; it is assigned after insertion.
const pathMappingEntrySchema = z.object({
  remotePath: z.string().trim().min(1, 'Remote path is required').max(500),
  localPath: z.string().trim().min(1, 'Local path is required').max(500),
});

export const createDownloadClientSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()),
  pathMappings: z.array(pathMappingEntrySchema).optional(),
}).superRefine(validateSettingsPerType);

export const updateDownloadClientSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: downloadClientTypeSchema.optional(),
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

export type CreateDownloadClientInput = z.infer<typeof createDownloadClientSchema>;

export const createDownloadClientFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    host: z.string().trim().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().optional(),
    password: z.string().trim().optional(),
    useSsl: z.boolean().optional(),
    apiKey: z.string().trim().optional(),
    category: z.string().trim().optional(),
    watchDir: z.string().trim().optional(),
    protocol: protocolSchema.optional(),
  }),
}).superRefine((data, ctx) => {
  const meta = DOWNLOAD_CLIENT_REGISTRY[data.type];
  if (meta) {
    for (const field of meta.requiredFields) {
      const value = data.settings[field.path as keyof typeof data.settings];
      if (!value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
      }
    }
  }
});

export type CreateDownloadClientFormData = z.infer<typeof createDownloadClientFormSchema>;

export const createRemotePathMappingSchema = z.object({
  downloadClientId: z.number().int().positive('Download client is required'),
  remotePath: z.string().trim().min(1, 'Remote path is required').max(500),
  localPath: z.string().trim().min(1, 'Local path is required').max(500),
});

export const updateRemotePathMappingSchema = z.object({
  downloadClientId: z.number().int().positive().optional(),
  remotePath: z.string().trim().min(1).max(500).optional(),
  localPath: z.string().trim().min(1).max(500).optional(),
});

export type CreateRemotePathMappingInput = z.infer<typeof createRemotePathMappingSchema>;
export type UpdateRemotePathMappingInput = z.infer<typeof updateRemotePathMappingSchema>;
