import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { ClockIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

interface SystemSettingsForm {
  backupIntervalMinutes: number;
  backupRetention: number;
}

export function BackupScheduleForm() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { isDirty } } = useForm<SystemSettingsForm>({
    defaultValues: { backupIntervalMinutes: 10080, backupRetention: 7 },
  });

  useEffect(() => {
    if (settings?.system) {
      reset({
        backupIntervalMinutes: settings.system.backupIntervalMinutes,
        backupRetention: settings.system.backupRetention,
      });
    }
  }, [settings, reset]);

  const settingsMutation = useMutation({
    mutationFn: (data: SystemSettingsForm) =>
      api.updateSettings({ system: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('System settings saved');
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, 'Failed to save settings'));
    },
  });

  return (
    <SettingsSection
      icon={<ClockIcon className="w-5 h-5 text-primary" />}
      title="Backup Schedule"
      description="Configure automatic backup frequency and retention."
    >
      <form onSubmit={handleSubmit((data) => settingsMutation.mutate(data))} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="backupIntervalMinutes" className="block text-sm font-medium mb-1.5">
              Backup Interval (minutes)
            </label>
            <input
              id="backupIntervalMinutes"
              type="number"
              {...register('backupIntervalMinutes', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus-ring"
              min={60}
              max={43200}
              disabled={settingsLoading}
            />
            <p className="text-xs text-muted-foreground mt-1">60–43200 (1 hour – 30 days). Default: 10080 (weekly).</p>
          </div>
          <div>
            <label htmlFor="backupRetention" className="block text-sm font-medium mb-1.5">
              Backup Retention
            </label>
            <input
              id="backupRetention"
              type="number"
              {...register('backupRetention', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus-ring"
              min={1}
              max={100}
              disabled={settingsLoading}
            />
            <p className="text-xs text-muted-foreground mt-1">Keep the most recent N backups (1–100). Default: 7.</p>
          </div>
        </div>
        <button
          type="submit"
          disabled={!isDirty || settingsMutation.isPending}
          className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring"
        >
          {settingsMutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </form>
    </SettingsSection>
  );
}
