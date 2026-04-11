import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { ConfirmModal } from '@/components/ConfirmModal';
import { useMutationWithToast } from '@/hooks/useMutationWithToast';

const MODE_LABELS: Record<AuthMode, string> = {
  none: 'None (No Authentication)',
  basic: 'Basic (Browser Prompt)',
  forms: 'Forms (Login Page)',
};

export function SecuritySettings() {
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
        envBypass={authStatus?.envBypass ?? false}
      />
      <AuthModeSection
        mode={authConfig.mode}
        hasUser={authStatus?.hasUser ?? false}
      />
      <LocalBypassSection localBypass={authConfig.localBypass} />
      <ApiKeySection apiKey={authConfig.apiKey} />
    </div>
  );
}

// ─── Auth Mode ─────────────────────────────────────────────────────

function AuthModeSection({
  mode,
  hasUser,
}: {
  mode: AuthMode;
  hasUser: boolean;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingMode, setPendingMode] = useState<AuthMode | null>(null);

  const mutation = useMutationWithToast({
    mutationFn: (newMode: AuthMode) => api.updateAuthConfig({ mode: newMode }),
    queryKey: [queryKeys.auth.config(), queryKeys.auth.status()],
    successMessage: 'Authentication mode updated',
    errorMessage: (err) => err instanceof ApiError ? err.message : 'Failed to update auth mode',
    onSuccess: () => { setShowConfirm(false); setPendingMode(null); },
    onError: () => { setShowConfirm(false); setPendingMode(null); },
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

      <ConfirmModal
        isOpen={showConfirm}
        title="Disable authentication?"
        message="Your instance will be accessible without credentials."
        confirmLabel={mutation.isPending ? 'Updating...' : 'Disable Auth'}
        confirmDisabled={mutation.isPending}
        onConfirm={() => pendingMode && mutation.mutate(pendingMode)}
        onCancel={() => { setShowConfirm(false); setPendingMode(null); }}
      />
    </SettingsSection>
  );
}

// ─── Local Bypass ──────────────────────────────────────────────────

function LocalBypassSection({ localBypass }: { localBypass: boolean }) {
  const mutation = useMutationWithToast({
    mutationFn: (enabled: boolean) => api.updateAuthConfig({ localBypass: enabled }),
    queryKey: [queryKeys.auth.config(), queryKeys.auth.status()],
    successMessage: 'Local bypass setting updated',
    errorMessage: 'Failed to update local bypass',
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

function ApiKeySection({ apiKey }: { apiKey: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const mutation = useMutationWithToast({
    mutationFn: api.authRegenerateApiKey,
    queryKey: queryKeys.auth.config(),
    successMessage: 'API key regenerated',
    errorMessage: 'Failed to regenerate API key',
    onSuccess: () => setShowConfirm(false),
  });

  async function handleCopy() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(apiKey);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = apiKey;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!ok) throw new Error('execCommand copy failed');
      }
      toast.success('Copied to clipboard');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
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

      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded-xl hover:bg-amber-500/10 transition-all duration-200"
      >
        <RefreshIcon className="w-4 h-4" />
        Regenerate API Key
      </button>
      <ConfirmModal
        isOpen={showConfirm}
        title="Regenerate API key?"
        message="Regenerating will invalidate the current key. Any integrations using it will need to be updated."
        confirmLabel={mutation.isPending ? 'Regenerating...' : 'Confirm Regenerate'}
        confirmDisabled={mutation.isPending}
        onConfirm={() => mutation.mutate()}
        onCancel={() => setShowConfirm(false)}
      />
    </SettingsSection>
  );
}
