import { useQuery } from '@tanstack/react-query';
import { api, formatBytes } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner, ServerIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

function InfoRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${mono ? 'font-mono text-xs tracking-tight' : ''}`}>{value}</span>
    </div>
  );
}

export function SystemInfo() {
  const { data: info, isLoading } = useQuery({
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

      {info && (
        <div>
          <InfoRow label="Version" value={info.version} mono />
          <InfoRow label="Node.js" value={info.nodeVersion} mono />
          <InfoRow label="OS" value={info.os} />
          <InfoRow label="Database Size" value={info.dbSize != null ? formatBytes(info.dbSize) : 'N/A'} />
          <InfoRow label="Library Path" value={info.libraryPath ?? 'Not configured'} mono />
          <InfoRow label="Free Space" value={info.freeSpace != null ? formatBytes(info.freeSpace) : 'N/A'} />
        </div>
      )}
    </SettingsSection>
  );
}
