import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { BackupMetadata } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import {
  LoadingSpinner,
  HardDriveIcon,
  UploadIcon,
  RefreshIcon,
} from '@/components/icons';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SettingsSection } from './SettingsSection';
import { BackupTable } from './BackupTable';
import { BackupScheduleForm } from './BackupScheduleForm';
import { HealthDashboard } from './HealthDashboard';
import { ScheduledTasks } from './ScheduledTasks';
import { SystemInfo } from './SystemInfo';
import { RecyclingBinSection } from './RecyclingBinSection';
import { GeneralSettingsForm } from './GeneralSettingsForm';

export function SystemSettings() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoreInfo, setRestoreInfo] = useState<{
    backupMigrationCount?: number;
    appMigrationCount?: number;
  } | null>(null);

  const { data: backups, isLoading } = useQuery({
    queryKey: queryKeys.backups(),
    queryFn: api.getBackups,
  });

  const createMutation = useMutation({
    mutationFn: api.createBackup,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backups() });
      if (result.created) {
        toast.success(`Backup created${result.pruned > 0 ? ` (${result.pruned} old backup${result.pruned > 1 ? 's' : ''} pruned)` : ''}`);
      } else {
        toast.error('Backup failed');
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create backup');
    },
  });

  const uploadMutation = useMutation({
    mutationFn: api.uploadRestore,
    onSuccess: (result) => {
      setRestoreInfo({
        backupMigrationCount: result.backupMigrationCount,
        appMigrationCount: result.appMigrationCount,
      });
      setRestoreConfirmOpen(true);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to validate restore file');
    },
  });

  const confirmMutation = useMutation({
    mutationFn: api.confirmRestore,
    onSuccess: () => {
      toast.success('Restore confirmed. Server is restarting...');
      setRestoreConfirmOpen(false);
      setRestoreInfo(null);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to confirm restore');
    },
  });

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      uploadMutation.mutate(file);
    }
    e.target.value = '';
  }

  function handleDownload(backup: BackupMetadata) {
    const url = api.getBackupDownloadUrl(backup.filename);
    const a = document.createElement('a');
    a.href = url;
    a.download = backup.filename;
    a.click();
  }

  return (
    <div className="space-y-8">
      <HealthDashboard />

      <BackupScheduleForm />

      <SettingsSection
        icon={<HardDriveIcon className="w-5 h-5 text-primary" />}
        title="Backup & Restore"
        description="Create, download, and restore database backups."
      >
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring"
          >
            {createMutation.isPending ? <LoadingSpinner className="w-4 h-4" /> : <RefreshIcon className="w-4 h-4" />}
            Create Backup
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
            className="flex items-center gap-2 px-4 py-2.5 border border-border font-medium rounded-xl hover:bg-muted disabled:opacity-50 transition-all text-sm focus-ring"
          >
            {uploadMutation.isPending ? <LoadingSpinner className="w-4 h-4" /> : <UploadIcon className="w-4 h-4" />}
            Restore from Backup
          </button>
          <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" />
        </div>

        <BackupTable backups={backups} isLoading={isLoading} onDownload={handleDownload} />
      </SettingsSection>

      <SystemInfo />

      <GeneralSettingsForm />

      <RecyclingBinSection />

      <ScheduledTasks />

      <ConfirmModal
        isOpen={restoreConfirmOpen}
        title="Confirm Restore"
        message={`This will replace your current database with the backup. The server process will exit and must be restarted to apply the change. If you are running under a process supervisor (Docker, systemd), it will restart automatically. If running via pnpm start or node directly, you will need to restart manually.${
          restoreInfo?.backupMigrationCount !== undefined
            ? ` Backup has ${restoreInfo.backupMigrationCount} migrations (app has ${restoreInfo.appMigrationCount}).`
            : ''
        }`}
        confirmLabel="Restore Now"
        cancelLabel="Cancel"
        onConfirm={() => confirmMutation.mutate()}
        onCancel={() => {
          setRestoreConfirmOpen(false);
          setRestoreInfo(null);
        }}
      />
    </div>
  );
}
