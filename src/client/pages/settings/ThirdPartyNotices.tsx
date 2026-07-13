import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner, ShieldIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

/**
 * System-tab licenses section (#1862). Renders the SAME `THIRD_PARTY_NOTICES.md` that ships
 * in the runtime image (fetched via `GET /api/system/notices`), so there is one source of
 * truth for the ffmpeg GPL/LGPL + permissive attributions and their full license texts.
 *
 * The notice is trusted, static, first-party content, so it renders as a whitespace-preserving
 * <pre> block — no HTML interpretation, no sanitization question. Styled to match the System
 * tab's CURRENT SettingsSection layout (the row-table migration reaches this tab later).
 */
export function ThirdPartyNotices() {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.thirdPartyNotices(),
    queryFn: api.getThirdPartyNotices,
  });

  return (
    <SettingsSection
      icon={<ShieldIcon className="w-5 h-5 text-primary" />}
      title="Licenses & Third-Party Notices"
      description="Attribution and license texts for FFmpeg and the codec libraries bundled in this image."
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
