import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { HealthCheckResult, HealthCheckTarget } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner, RefreshIcon, CheckCircleIcon, AlertCircleIcon, AlertTriangleIcon, ActivityIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

const stateStyles = {
  healthy: {
    icon: CheckCircleIcon,
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/5 border-emerald-500/20',
    label: 'Healthy',
  },
  warning: {
    icon: AlertTriangleIcon,
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/30',
    label: 'Warning',
  },
  error: {
    icon: AlertCircleIcon,
    text: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-500/10 border-red-500/30',
    label: 'Error',
  },
} as const;

function targetToHref(target: HealthCheckTarget): string {
  switch (target.kind) {
    case 'indexer':
      return `/settings/indexers?edit=${target.id}`;
    case 'download-client':
      return `/settings/download-clients?edit=${target.id}`;
    case 'settings':
      return `/settings/${target.path}`;
    case 'route':
      return target.path;
  }
}

function cardKey(check: HealthCheckResult): string {
  const target = check.target;
  if (!target) return check.checkName;
  if (target.kind === 'indexer' || target.kind === 'download-client') {
    return `${target.kind}:${target.id}`;
  }
  return `${target.kind}:${target.path}`;
}

function HealthCard({ check }: { check: HealthCheckResult }) {
  const navigate = useNavigate();
  const style = stateStyles[check.state] ?? stateStyles.healthy;
  const Icon = style.icon;
  const href = check.target ? targetToHref(check.target) : null;

  const content = (
    <>
      <div className="shrink-0 mt-0.5">
        <Icon className={`w-4.5 h-4.5 ${style.text}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-sm truncate">{check.checkName}</p>
          <span className={`text-[10px] font-semibold uppercase tracking-wider shrink-0 ${style.text}`}>
            {style.label}
          </span>
        </div>
        {check.message && (
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{check.message}</p>
        )}
      </div>
    </>
  );

  if (href === null) {
    return (
      <div className={`flex items-start gap-3 p-3.5 rounded-xl border transition-colors ${style.bg}`}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate(href)}
      className={`flex items-start gap-3 p-3.5 rounded-xl border transition-colors text-left w-full cursor-pointer hover:brightness-110 focus-ring ${style.bg}`}
    >
      {content}
    </button>
  );
}

export function HealthDashboard() {
  const queryClient = useQueryClient();

  const { data: checks, isLoading, isError } = useQuery({
    queryKey: queryKeys.health.status(),
    queryFn: api.getHealthStatus,
    refetchInterval: 60_000,
  });

  const runMutation = useMutation({
    mutationFn: api.runHealthCheck,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.health.status() });
      queryClient.invalidateQueries({ queryKey: queryKeys.health.summary() });
    },
  });

  return (
    <SettingsSection
      icon={<ActivityIcon className="w-5 h-5 text-primary" />}
      title="Health Checks"
      description="Monitor the health of your system components."
    >
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 transition-all focus-ring"
        >
          {runMutation.isPending ? <LoadingSpinner className="w-3.5 h-3.5" /> : <RefreshIcon className="w-3.5 h-3.5" />}
          Run Now
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <LoadingSpinner className="w-4 h-4" />
          Loading health checks...
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-500">Failed to load health checks.</p>
      )}

      {checks && checks.length === 0 && (
        <p className="text-sm text-muted-foreground">No health checks available.</p>
      )}

      {checks && checks.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {checks.map((check) => (
            <HealthCard key={cardKey(check)} check={check} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

