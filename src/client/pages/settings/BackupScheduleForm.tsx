import type { z } from 'zod';
import { ClockIcon } from '@/components/icons';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, systemFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type SystemFormData = z.infer<typeof systemFormSchema>;

export function BackupScheduleForm() {
  const { form, mutation, onSubmit } = useSettingsForm<SystemFormData>({
    schema: systemFormSchema,
    defaultValues: {
      backupIntervalMinutes: DEFAULT_SETTINGS.system.backupIntervalMinutes,
      backupRetention: DEFAULT_SETTINGS.system.backupRetention,
    },
    select: (s: AppSettings) => ({
      backupIntervalMinutes: s.system.backupIntervalMinutes,
      backupRetention: s.system.backupRetention,
    }),
    toPayload: (d) => ({ system: d }),
    successMessage: 'System settings saved',
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<ClockIcon className="w-5 h-5 text-primary" />}
      title="Backup Schedule"
      description="Configure automatic backup frequency and retention."
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label htmlFor="backupIntervalMinutes" className="block text-sm font-medium mb-1.5">
              Backup Interval (minutes)
            </label>
            <input
              id="backupIntervalMinutes"
              type="number"
              {...register('backupIntervalMinutes', { valueAsNumber: true })}
              className={errorInputClass(!!errors.backupIntervalMinutes)}
              min={60}
              max={43200}
              step={1}
            />
            {errors.backupIntervalMinutes && (
              <p className="text-sm text-destructive mt-1">{errors.backupIntervalMinutes.message}</p>
            )}
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
              className={errorInputClass(!!errors.backupRetention)}
              min={1}
              max={100}
              step={1}
            />
            {errors.backupRetention && (
              <p className="text-sm text-destructive mt-1">{errors.backupRetention.message}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">Keep the most recent N backups (1–100). Default: 7.</p>
          </div>
        </div>
        {isDirty && (
          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </form>
    </SettingsSection>
  );
}
