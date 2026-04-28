import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { URL_BASE } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import type { AuthMode } from '../../shared/schemas.js';

export interface AuthState {
  mode: AuthMode;
  hasUser: boolean;
  localBypass: boolean;
  bypassActive: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
}

export function useAuth(): AuthState {
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: queryKeys.auth.status(),
    queryFn: api.getAuthStatus,
    staleTime: 30_000,
    retry: 1,
  });

  // Admin-only fields (#742) live behind authentication. Only fetch once the public
  // status reports authenticated, so pre-login mounts (login page, layout) do not 401.
  const isAuthenticated = status?.authenticated ?? false;
  const { data: adminStatus } = useQuery({
    queryKey: queryKeys.auth.adminStatus(),
    queryFn: api.getAuthAdminStatus,
    enabled: isAuthenticated,
    staleTime: 30_000,
    retry: 1,
  });

  const logout = useCallback(async () => {
    await api.authLogout();
    queryClient.setQueryData(queryKeys.auth.status(), undefined);
    queryClient.setQueryData(queryKeys.auth.adminStatus(), undefined);
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
    window.location.href = `${URL_BASE}/login`;
  }, [queryClient]);

  return {
    mode: status?.mode ?? 'none',
    hasUser: adminStatus?.hasUser ?? false,
    localBypass: adminStatus?.localBypass ?? false,
    bypassActive: adminStatus?.bypassActive ?? false,
    isAuthenticated,
    isLoading,
    logout,
  };
}
