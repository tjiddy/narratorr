import { useContext } from 'react';
import { AuthContext, type AuthState } from '@/components/AuthContext';

export function useAuthContext(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return ctx;
}
