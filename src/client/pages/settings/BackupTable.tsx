import type { BackupMetadata } from '@/lib/api';
import { formatBytes } from '@/lib/api';
import {
  LoadingSpinner,
  HardDriveIcon,
  DownloadIcon,
} from '@/components/icons';

interface BackupTableProps {
  backups: BackupMetadata[] | undefined;
  isLoading: boolean;
  onDownload: (backup: BackupMetadata) => void;
}

export function BackupTable({ backups, isLoading, onDownload }: BackupTableProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner className="w-6 h-6 text-primary" />
      </div>
    );
  }

  if (!backups?.length) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <div className="flex items-center justify-center w-14 h-14 mx-auto mb-4 bg-muted/60 rounded-2xl">
          <HardDriveIcon className="w-7 h-7 opacity-40" />
        </div>
        <p className="text-sm font-medium mb-1">No backups yet</p>
        <p className="text-xs text-muted-foreground/70">Create your first backup to protect your data.</p>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden animate-fade-in">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Filename</th>
            <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3 hidden sm:table-cell">Date</th>
            <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Size</th>
            <th className="w-16" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {backups.map((backup) => (
            <tr key={backup.filename} className="hover:bg-muted/30 transition-colors group">
              <td className="px-4 py-3.5">
                <span className="text-sm font-mono text-foreground/90 truncate block max-w-[300px]">
                  {backup.filename}
                </span>
                <span className="text-xs text-muted-foreground sm:hidden mt-0.5 block">
                  {new Date(backup.timestamp).toLocaleString()}
                </span>
              </td>
              <td className="px-4 py-3.5 text-sm text-muted-foreground hidden sm:table-cell">
                {new Date(backup.timestamp).toLocaleString()}
              </td>
              <td className="px-4 py-3.5 text-sm text-muted-foreground text-right tabular-nums">
                {formatBytes(backup.size)}
              </td>
              <td className="px-3 py-3.5 text-right">
                <button
                  type="button"
                  onClick={() => onDownload(backup)}
                  className="p-2 text-muted-foreground hover:text-primary transition-colors rounded-lg hover:bg-primary/10 focus-ring"
                  title="Download backup"
                >
                  <DownloadIcon className="w-4 h-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
