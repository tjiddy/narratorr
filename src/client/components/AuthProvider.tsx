import { useEffect, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { LoadingSpinner } from '@/components/icons';
import { AuthContext } from './AuthContext.js';

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (auth.isLoading) return;

    // In forms mode, redirect unauthenticated users to /login unless bypass is active
    if (auth.mode === 'forms' && !auth.isAuthenticated && !auth.bypassActive && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  }, [auth.isLoading, auth.mode, auth.isAuthenticated, auth.bypassActive, location.pathname, navigate]);

  // Show loading while auth state resolves, or while redirecting to login
  const needsRedirect = auth.mode === 'forms' && !auth.isAuthenticated && !auth.bypassActive && location.pathname !== '/login';
  if (auth.isLoading || needsRedirect) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}
