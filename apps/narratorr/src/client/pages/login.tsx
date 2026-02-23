import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { HeadphonesIcon, LoadingSpinner } from '@/components/icons';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      await api.login(username, password);
      // Invalidate auth status to refetch with new session cookie
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
      navigate('/library', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid username or password');
      } else {
        setError('Login failed. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen gradient-bg noise-overlay flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 animate-fade-in-up">
          <div className="relative mb-4">
            <div className="absolute inset-0 bg-primary/20 rounded-xl blur-xl animate-pulse-glow" />
            <div className="relative bg-gradient-to-br from-primary to-amber-500 p-3.5 rounded-xl shadow-lg shadow-primary/20">
              <HeadphonesIcon className="w-8 h-8 text-primary-foreground" />
            </div>
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">narratorr</h1>
          <p className="text-muted-foreground mt-1 text-sm">Sign in to continue</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="glass-card rounded-2xl p-6 sm:p-8 space-y-5 animate-fade-in-up stagger-2">
          {error && (
            <div className="flex items-center gap-2.5 bg-destructive/10 text-destructive text-sm rounded-xl px-4 py-3 animate-fade-in border border-destructive/20">
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" x2="12" y1="8" y2="12" />
                <line x1="12" x2="12.01" y1="16" y2="16" />
              </svg>
              {error}
            </div>
          )}

          <div>
            <label htmlFor="login-username" className="block text-sm font-medium text-foreground mb-1.5">
              Username
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              className="w-full px-4 py-3 rounded-xl bg-muted/50 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/80 transition-all"
              placeholder="Enter username"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-foreground mb-1.5">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full px-4 py-3 rounded-xl bg-muted/50 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/80 transition-all"
              placeholder="Enter password"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full px-4 py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 focus-ring transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-primary/20"
          >
            {isSubmitting ? (
              <>
                <LoadingSpinner className="w-4 h-4" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
