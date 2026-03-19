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

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.auth.status(),
    queryFn: api.getAuthStatus,
    staleTime: 30_000,
    retry: 1,
  });

  const logout = useCallback(async () => {
    await api.authLogout();
    queryClient.setQueryData(queryKeys.auth.status(), undefined);
    // Force refetch to get updated status
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
    window.location.href = `${URL_BASE}/login`;
  }, [queryClient]);

  // Server-determined authentication state:
  // 'none' mode → always true, 'basic' → always true, 'forms' → based on session cookie validity
  const isAuthenticated = data?.authenticated ?? false;

  return {
    mode: data?.mode ?? 'none',
    hasUser: data?.hasUser ?? false,
    localBypass: data?.localBypass ?? false,
    bypassActive: data?.bypassActive ?? false,
    isAuthenticated,
    isLoading,
    logout,
  };
}
