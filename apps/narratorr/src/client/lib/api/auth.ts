import type { AuthMode } from '../../../shared/schemas.js';
import { fetchApi } from './client.js';

export interface AuthStatus {
  mode: AuthMode;
  hasUser: boolean;
  username?: string;
  localBypass: boolean;
  authenticated: boolean;
}

export interface AuthConfig {
  mode: AuthMode;
  apiKey: string;
  localBypass: boolean;
}

export const authApi = {
  getStatus: () => fetchApi<AuthStatus>('/auth/status'),

  login: (username: string, password: string) =>
    fetchApi<{ success: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () =>
    fetchApi<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),

  setup: (username: string, password: string) =>
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

  changePassword: (currentPassword: string, newPassword: string, newUsername?: string) =>
    fetchApi<{ success: boolean }>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword, ...(newUsername ? { newUsername } : {}) }),
    }),

  regenerateApiKey: () =>
    fetchApi<{ apiKey: string }>('/auth/api-key/regenerate', {
      method: 'POST',
    }),
};
