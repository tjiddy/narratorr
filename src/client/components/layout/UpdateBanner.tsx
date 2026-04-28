import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { XIcon, ZapIcon } from '@/components/icons';

export function UpdateBanner() {
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: queryKeys.updateStatus(),
    queryFn: api.getUpdateStatus,
    refetchInterval: 60 * 60 * 1000, // re-check hourly
    retry: false,
  });

  const dismiss = useMutation({
    mutationFn: (version: string) => api.dismissUpdate(version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus() });
    },
  });

  const update = status?.update;
  if (!update || update.dismissed) return null;

  return (
    <div className="relative overflow-hidden border-b border-primary/20 bg-gradient-to-r from-primary/10 via-primary/5 to-amber-500/10 animate-fade-in">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_left,_hsl(var(--primary)/0.08),transparent_60%)]" />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 text-sm text-foreground/80">
          <span className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/15">
            <ZapIcon className="w-3 h-3 text-primary" />
          </span>
          <span>
            <span className="text-muted-foreground">Update available</span>
            {' '}
            <strong className="font-semibold text-foreground">v{update.latestVersion}</strong>
            <span className="text-muted-foreground/60 mx-1.5">&middot;</span>
            <a
              href={update.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:text-primary/80 underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 transition-colors"
            >
              Release notes
            </a>
          </span>
        </div>
        <button
          type="button"
          onClick={() => dismiss.mutate(update.latestVersion)}
          className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200"
          aria-label="Dismiss update notification"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
