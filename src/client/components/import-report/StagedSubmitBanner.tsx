import { AlertCircleIcon } from '@/components/icons';

/** In-session staged-pipeline errors, distinct from durable import-attention state. */
export function StagedSubmitBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div role="status" className="glass-card rounded-xl p-4 flex items-center gap-3 border border-amber-400/30 text-sm animate-fade-in-up">
      <AlertCircleIcon className="w-5 h-5 text-amber-400 shrink-0" />
      <span className="flex-1 text-muted-foreground">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors focus-ring rounded"
      >
        Dismiss
      </button>
    </div>
  );
}
