import { useQuery } from '@tanstack/react-query';
import { api, formatBytes } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner, ServerIcon } from '@/components/icons';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { SettingsSection } from './SettingsSection';

function InfoValue({ value, mono = false }: { value: React.ReactNode; mono?: boolean }) {
  return <span className={`text-sm font-medium ${mono ? 'font-mono text-xs tracking-tight' : ''}`}>{value}</span>;
}

export function SystemInfo() {
  const { data: info, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.systemInfo(),
    queryFn: api.getSystemInfo,
  });

  return (
    <SettingsSection
      icon={<ServerIcon className="w-5 h-5 text-primary" />}
      title="System Information"
      description="Server and environment details."
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <LoadingSpinner className="w-4 h-4" />
          Loading system info...
        </div>
      )}

      {/* Without this the failed read renders as a heading over nothing — a blank card the
          operator cannot tell from a server that reported no details. The Retry name is
          surface-specific because SystemSettings composes three failable sections. */}
      {isError && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load system information.</p>
          <button
            type="button"
            onClick={() => { void refetch(); }}
            aria-label="Retry loading system information"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      )}

      {info && (
        <SettingsTable>
          <SettingsRow label="Version">
            <InfoValue mono value={info.commit !== 'unknown' ? `${info.version} (${info.commit})` : info.version} />
          </SettingsRow>
          {info.buildTime && info.buildTime !== 'unknown' && (
            <SettingsRow label="Built">
              <InfoValue value={new Date(info.buildTime).toLocaleString()} />
            </SettingsRow>
          )}
          <SettingsRow label="Node.js">
            <InfoValue mono value={info.nodeVersion} />
          </SettingsRow>
          <SettingsRow label="OS">
            <InfoValue value={info.os} />
          </SettingsRow>
          <SettingsRow label="Database Size">
            <InfoValue value={info.dbSize != null ? formatBytes(info.dbSize) : 'N/A'} />
          </SettingsRow>
          <SettingsRow label="Free Space">
            <InfoValue value={info.freeSpace != null ? formatBytes(info.freeSpace) : 'N/A'} />
          </SettingsRow>
          <SettingsRow label="Library Path">
            <InfoValue mono value={info.libraryPath ?? 'Not configured'} />
          </SettingsRow>
        </SettingsTable>
      )}
    </SettingsSection>
  );
}
