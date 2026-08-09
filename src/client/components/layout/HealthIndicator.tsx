import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function HealthIndicator() {
  const { data: summary } = useQuery({
    queryKey: queryKeys.health.summary(),
    queryFn: api.getHealthSummary,
    refetchInterval: 60_000,
  });

  if (!summary || summary.state === 'healthy') return null;

  const isError = summary.state === 'error';
  const dotColor = isError ? 'bg-red-500' : 'bg-amber-500';
  const glowColor = isError ? 'shadow-red-500/40' : 'shadow-amber-500/40';

  // Keep this a Link so the unsaved-changes guard can intercept dirty-form navigation.
  return (
    <Link
      to="/settings/system"
      data-testid="health-indicator"
      className="relative p-2 rounded-xl hover:bg-muted/50 transition-colors focus-ring"
      title={`Health: ${summary.state} — click to view details`}
      aria-label={`Health: ${summary.state} — click to view details`}
    >
      <span className={`block w-2.5 h-2.5 rounded-full ${dotColor} ${glowColor} shadow-lg animate-pulse`} />
    </Link>
  );
}
