import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner, ShieldIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

/** Renders the runtime image's bundled notice as trusted text in a pre, without HTML interpretation. */
export function ThirdPartyNotices() {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.thirdPartyNotices(),
    queryFn: api.getThirdPartyNotices,
  });

  return (
    <SettingsSection
      icon={<ShieldIcon className="w-5 h-5 text-primary" />}
      title="Licenses & Third-Party Notices"
      description="Attribution and license texts for the FFmpeg binary bundled in this image."
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <LoadingSpinner className="w-4 h-4" />
          Loading third-party notices...
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-500">Failed to load third-party notices.</p>
      )}

      {data && (
        <pre className="max-h-96 overflow-auto rounded-xl border border-border/50 bg-muted/30 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
          {data.content}
        </pre>
      )}
    </SettingsSection>
  );
}
