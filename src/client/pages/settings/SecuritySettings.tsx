import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { AuthMode } from '../../../shared/schemas.js';
import {
  LoadingSpinner,
  ShieldIcon,
  KeyIcon,
  CopyIcon,
  RefreshIcon,
  WifiIcon,
} from '@/components/icons';
import { SettingsSection } from './SettingsSection';
import { CredentialsSection } from './CredentialsSection';

const MODE_LABELS: Record<AuthMode, string> = {
  none: 'None (No Authentication)',
  basic: 'Basic (Browser Prompt)',
  forms: 'Forms (Login Page)',
};

export function SecuritySettings() {
  const queryClient = useQueryClient();

  const { data: authConfig, isLoading } = useQuery({
    queryKey: queryKeys.auth.config(),
    queryFn: api.getAuthConfig,
  });

  const { data: authStatus } = useQuery({
    queryKey: queryKeys.auth.status(),
    queryFn: api.getAuthStatus,
  });

  if (isLoading || !authConfig) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <CredentialsSection
        hasUser={authStatus?.hasUser ?? false}
        currentUsername={authStatus?.username}
        bypassActive={authStatus?.bypassActive ?? false}
        queryClient={queryClient}
      />
      <AuthModeSection
        mode={authConfig.mode}
        hasUser={authStatus?.hasUser ?? false}
        queryClient={queryClient}
      />
      <LocalBypassSection
        localBypass={authConfig.localBypass}
        queryClient={queryClient}
      />
      <ApiKeySection
        apiKey={authConfig.apiKey}
        queryClient={queryClient}
      />
    </div>
  );
}

// ─── Auth Mode ─────────────────────────────────────────────────────

function AuthModeSection({
  mode,
  hasUser,
  queryClient,
}: {
  mode: AuthMode;
  hasUser: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingMode, setPendingMode] = useState<AuthMode | null>(null);

  const mutation = useMutation({
    mutationFn: (newMode: AuthMode) => api.updateAuthConfig({ mode: newMode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.config() });
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
      toast.success('Authentication mode updated');
      setShowConfirm(false);
      setPendingMode(null);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Failed to update auth mode';
      toast.error(message);
      setShowConfirm(false);
      setPendingMode(null);
    },
  });

  function handleModeChange(newMode: AuthMode) {
    if (newMode === mode) return;

    // Switching to none — show warning
    if (newMode === 'none' && mode !== 'none') {
      setPendingMode(newMode);
      setShowConfirm(true);
      return;
    }

    mutation.mutate(newMode);
  }

  return (
    <SettingsSection
      icon={<ShieldIcon className="w-5 h-5 text-primary" />}
      title="Authentication Mode"
      description="Control how users authenticate with Narratorr"
    >
      <div className="space-y-3">
        {(['none', 'basic', 'forms'] as AuthMode[]).map((m) => {
          const needsCredentials = m !== 'none' && !hasUser;
          return (
            <label
              key={m}
              className={`
                flex items-center gap-3.5 p-4 rounded-xl border transition-all duration-200
                ${needsCredentials
                  ? 'cursor-not-allowed opacity-50'
                  : 'cursor-pointer'
                }
                ${mode === m
                  ? 'border-primary/60 bg-primary/5 shadow-sm shadow-primary/10'
                  : needsCredentials
                    ? 'border-border'
                    : 'border-border hover:border-primary/30 hover:bg-muted/30'
                }
              `}
              title={needsCredentials ? 'Create credentials above first' : undefined}
            >
              <input
                type="radio"
                name="authMode"
                value={m}
                checked={mode === m}
                disabled={needsCredentials}
                onChange={() => handleModeChange(m)}
                className="accent-primary"
              />
              <span className="font-medium">{MODE_LABELS[m]}</span>
            </label>
          );
        })}
      </div>

      {/* Confirmation dialog for disabling auth */}
      {showConfirm && (
        <div className="mt-4 p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 animate-fade-in">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-3">
            Are you sure you want to disable authentication? Your instance will be accessible without credentials.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => pendingMode && mutation.mutate(pendingMode)}
              disabled={mutation.isPending}
              className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors shadow-sm"
            >
              {mutation.isPending ? 'Updating...' : 'Disable Auth'}
            </button>
            <button
              onClick={() => { setShowConfirm(false); setPendingMode(null); }}
              className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

// ─── Local Bypass ──────────────────────────────────────────────────

function LocalBypassSection({
  localBypass,
  queryClient,
}: {
  localBypass: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateAuthConfig({ localBypass: enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.config() });
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.status() });
      toast.success('Local bypass setting updated');
    },
    onError: () => toast.error('Failed to update local bypass'),
  });

  return (
    <SettingsSection
      icon={<WifiIcon className="w-5 h-5 text-primary" />}
      title="Local Network Bypass"
      description="Skip authentication for requests from local/private IP addresses"
    >
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={localBypass}
          onChange={(e) => mutation.mutate(e.target.checked)}
          className="w-4 h-4 accent-primary rounded"
        />
        <div>
          <span className="font-medium">Enable local bypass</span>
          <p className="text-sm text-muted-foreground">
            Requests from private IPs (10.x, 172.16-31.x, 192.168.x, localhost) will skip authentication
          </p>
        </div>
      </label>
    </SettingsSection>
  );
}

// ─── API Key ───────────────────────────────────────────────────────

function ApiKeySection({
  apiKey,
  queryClient,
}: {
  apiKey: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: api.authRegenerateApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.config() });
      toast.success('API key regenerated');
      setShowConfirm(false);
    },
    onError: () => toast.error('Failed to regenerate API key'),
  });

  async function handleCopy() {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <SettingsSection
      icon={<KeyIcon className="w-5 h-5 text-primary" />}
      title="API Key"
      description="Use this key for programmatic access via X-Api-Key header or ?apikey= query parameter"
    >
      <div className="flex items-center gap-2">
        <code className="flex-1 px-4 py-3 bg-muted/40 border border-border rounded-xl font-mono text-sm break-all select-all tracking-wide">
          {apiKey}
        </code>
        <button
          onClick={handleCopy}
          className="shrink-0 p-3 rounded-xl border border-border hover:bg-muted hover:border-primary/30 transition-all duration-200 focus-ring"
          title="Copy to clipboard"
        >
          <CopyIcon className="w-4 h-4" />
          {copied && <span className="sr-only">Copied!</span>}
        </button>
      </div>

      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded-xl hover:bg-amber-500/10 transition-all duration-200"
        >
          <RefreshIcon className="w-4 h-4" />
          Regenerate API Key
        </button>
      ) : (
        <div className="p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 animate-fade-in">
          <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">
            Regenerating will invalidate the current key. Any integrations using it will need to be updated.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors shadow-sm"
            >
              {mutation.isPending ? 'Regenerating...' : 'Confirm Regenerate'}
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
