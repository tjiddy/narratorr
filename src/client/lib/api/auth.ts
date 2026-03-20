import type { AuthMode } from '../../../shared/schemas.js';
import { fetchApi } from './client.js';

export interface AuthStatus {
  mode: AuthMode;
  hasUser: boolean;
  username?: string;
  localBypass: boolean;
  authenticated: boolean;
  bypassActive: boolean;
  envBypass: boolean;
}

export interface AuthConfig {
  mode: AuthMode;
  apiKey: string;
  localBypass: boolean;
}

export const authApi = {
  getAuthStatus: () => fetchApi<AuthStatus>('/auth/status'),

  authLogin: (username: string, password: string) =>
    fetchApi<{ success: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  authLogout: () =>
    fetchApi<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),

  authSetup: (username: string, password: string) =>
    fetchApi<{ success: boolean }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getAuthConfig: () => fetchApi<AuthConfig>('/auth/config'),

  updateAuthConfig: (data: { mode?: AuthMode; localBypass?: boolean }) =>
    fetchApi<AuthConfig>('/auth/config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  authChangePassword: (currentPassword: string, newPassword: string, newUsername?: string) =>
    fetchApi<{ success: boolean }>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword, ...(newUsername ? { newUsername } : {}) }),
    }),

  authRegenerateApiKey: () =>
    fetchApi<{ apiKey: string }>('/auth/api-key/regenerate', {
      method: 'POST',
    }),

  authDeleteCredentials: () =>
    fetchApi<{ success: boolean }>('/auth/credentials', {
      method: 'DELETE',
    }),
};
