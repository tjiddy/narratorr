import { LoadingSpinner, CheckCircleIcon, AlertCircleIcon, RefreshIcon, XCircleIcon } from '@/components/icons';
import type { MergeOutcome } from '@/hooks/useMergeProgress';

export function MergeStatusIcon({ outcome, phase }: { outcome?: MergeOutcome; phase: string }) {
  if (outcome === 'success') return <CheckCircleIcon className="w-4 h-4 text-success" />;
  if (outcome === 'error') return <AlertCircleIcon className="w-4 h-4 text-destructive" />;
  if (outcome === 'cancelled') return <XCircleIcon className="w-4 h-4 text-muted-foreground" />;
  if (phase === 'queued') return <LoadingSpinner className="w-4 h-4 text-primary" />;
  return <RefreshIcon className="w-4 h-4 text-primary animate-spin" />;
}
