import { AlertCircleIcon } from '@/components/icons';
import type { HeldReviewItem } from '@/lib/api';

interface HeldReviewPanelProps {
  heldReview: HeldReviewItem[];
  onReconfirm: () => void;
  isPending: boolean;
}

/**
 * Held for recording review (#1711) — items the server could not confirm as the
 * same vs a different recording of a book you own. Not imported; re-confirm to
 * keep both recordings. Shared by Manual Import and Library Import (#1732).
 */
export function HeldReviewPanel({ heldReview, onReconfirm, isPending }: HeldReviewPanelProps) {
  if (heldReview.length === 0) return null;

  return (
    <div className="glass-card rounded-xl p-4 flex flex-col gap-3 animate-fade-in-up" data-testid="held-review-panel">
      <div className="flex items-center gap-2">
        <AlertCircleIcon className="w-5 h-5 text-amber-400" />
        <p className="text-sm font-medium">
          {heldReview.length} item{heldReview.length !== 1 ? 's' : ''} held for recording review
        </p>
      </div>
      <ul className="text-sm text-muted-foreground list-disc pl-8 space-y-0.5">
        {heldReview.map((h) => (
          <li key={h.path}>{h.title}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        These may be a different recording of a book you already own. Re-confirm to import them as separate recordings.
      </p>
      <button
        type="button"
        onClick={onReconfirm}
        disabled={isPending}
        className="self-start px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all focus-ring disabled:opacity-50"
      >
        {isPending ? 'Importing...' : 'Re-confirm and import'}
      </button>
    </div>
  );
}
