import { z } from 'zod';
import { DOWNLOAD_CLIENT_REGISTRY, DOWNLOAD_CLIENT_TYPES } from '../download-client-registry';

// ============================================================================
// Download Client schemas
// ============================================================================

export const downloadClientTypeSchema = z.enum(DOWNLOAD_CLIENT_TYPES);

// Server-side: accepts any settings shape (type-specific validation is client-side only)
export const createDownloadClientSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()),
});

export const updateDownloadClientSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Output types (after Zod applies defaults)
export type CreateDownloadClientInput = z.infer<typeof createDownloadClientSchema>;
export type UpdateDownloadClientInput = z.infer<typeof updateDownloadClientSchema>;

// Form schema: all possible settings fields optional, superRefine validates per-type
export const createDownloadClientFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    useSsl: z.boolean().optional(),
    apiKey: z.string().optional(),
    category: z.string().optional(),
    watchDir: z.string().optional(),
    downloadRoot: z.string().optional(),
    protocol: z.enum(['torrent', 'usenet']).optional(),
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

// ============================================================================
// Remote Path Mapping schemas
// ============================================================================

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
