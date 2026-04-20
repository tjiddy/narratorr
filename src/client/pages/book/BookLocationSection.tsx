import { toast } from 'sonner';
import { CopyIcon } from '@/components/icons';

export function BookLocationSection({ path }: { path: string }) {
  async function handleCopy() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(path);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = path;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!ok) throw new Error('execCommand copy failed');
      }
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Location
      </h2>
      <div className="glass-card rounded-2xl p-4">
        <div className="flex items-center gap-2">
          <code
            className="flex-1 px-4 py-3 bg-muted/40 border border-border rounded-xl font-mono text-sm break-all select-all tracking-wide"
            title={path}
          >
            {path}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 p-3 rounded-xl border border-border hover:bg-muted hover:border-primary/30 transition-all duration-200 focus-ring"
            title="Copy to clipboard"
          >
            <CopyIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
