import { AlertCircleIcon, LoadingSpinner } from '@/components/icons';
import { pausedReasonDetail, type PausedReason } from '@/hooks/match-recovery';

interface MatchPausedBannerProps {
  reason: PausedReason;
  /** Original candidates still without a result — the resume target. */
  remaining: number;
  /** The logical run's original candidate count. */
  total: number;
  onResume: () => void;
  onRestart: () => void;
  /** A Resume/Restart request is in flight — both actions are single-submit. */
  busy: boolean;
}

/**
 * Shared match-phase recovery banner (#1864), rendered identically on the Library
 * Import and Manual Import surfaces (DRY-2). Copy is reason-mapped domain text only
 * (`pausedReasonDetail`) — never raw error/server strings. Both actions are
 * single-submit: disabled while their request is pending.
 */
export function MatchPausedBanner({ reason, remaining, total, onResume, onRestart, busy }: MatchPausedBannerProps) {
  return (
    <div
      className="glass-card rounded-xl p-6 flex flex-col items-center gap-3 text-center animate-fade-in-up"
      role="alert"
      data-testid="match-paused-banner"
    >
      <AlertCircleIcon className="w-8 h-8 text-amber-400" />
      <div>
        <p className="font-medium mb-1">
          Matching paused — {remaining} of {total} book{total !== 1 ? 's' : ''} remaining.
        </p>
        <p className="text-sm text-muted-foreground">{pausedReasonDetail(reason)}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
        >
          {busy && <LoadingSpinner className="w-3.5 h-3.5" />}
          Resume remaining
        </button>
        <button
          type="button"
          onClick={onRestart}
          disabled={busy}
          className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
        >
          Restart all
        </button>
      </div>
    </div>
  );
}
