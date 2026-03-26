import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function HealthIndicator() {
  const navigate = useNavigate();

  const { data: summary } = useQuery({
    queryKey: queryKeys.health.summary(),
    queryFn: api.getHealthSummary,
    refetchInterval: 60_000,
  });

  if (!summary || summary.state === 'healthy') return null;

  const isError = summary.state === 'error';
  const dotColor = isError ? 'bg-red-500' : 'bg-amber-500';
  const glowColor = isError ? 'shadow-red-500/40' : 'shadow-amber-500/40';

  return (
    <button
      type="button"
      data-testid="health-indicator"
      onClick={() => navigate('/settings/system')}
      className="relative p-2 rounded-xl hover:bg-muted/50 transition-colors focus-ring"
      title={`Health: ${summary.state} — click to view details`}
      aria-label={`Health: ${summary.state} — click to view details`}
    >
      <span className={`block w-2.5 h-2.5 rounded-full ${dotColor} ${glowColor} shadow-lg animate-pulse`} />
    </button>
  );
}
