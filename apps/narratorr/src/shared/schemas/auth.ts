import { z } from 'zod';

// ============================================================================
// Auth schemas
// ============================================================================

export const authModeSchema = z.enum(['none', 'basic', 'forms']);
export type AuthMode = z.infer<typeof authModeSchema>;

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const setupCredentialsSchema = z.object({
  username: z.string().min(1, 'Username is required').max(50),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export type SetupCredentialsInput = z.infer<typeof setupCredentialsSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateAuthConfigSchema = z.object({
  mode: authModeSchema.optional(),
  localBypass: z.boolean().optional(),
});

export type UpdateAuthConfigInput = z.infer<typeof updateAuthConfigSchema>;
