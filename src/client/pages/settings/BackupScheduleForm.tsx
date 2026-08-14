import type { z } from 'zod';
import { ClockIcon } from '@/components/icons';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { NumberField } from '@/components/settings/NumberField';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, systemFormSchema, type AppSettings } from '@shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type SystemFormData = z.infer<typeof systemFormSchema>;

// Guard label and section title must stay identical.
const CARD_LABEL = 'Backup Schedule';

export function BackupScheduleForm() {
  const { form, mutation, onSubmit, settingsError, refetchSettings } = useSettingsForm<SystemFormData>({
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
    label: CARD_LABEL,
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<ClockIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Configure automatic backup frequency and retention."
    >
      {/* A weekly interval and 7 retained backups read as the operator's schedule; both
          are schema defaults, and saving one would overwrite the real one. */}
      {settingsError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load backup schedule settings.</p>
          <button
            type="button"
            onClick={refetchSettings}
            aria-label="Retry loading backup schedule settings"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
          <SettingsTable>
            <SettingsRow
              htmlFor="backupIntervalMinutes"
              label="Backup interval"
              description="How often automatic backups run. 60–43200 (1 hour – 30 days). Default: 10080 (weekly)."
            >
              <NumberField
                id="backupIntervalMinutes"
                {...register('backupIntervalMinutes', { valueAsNumber: true })}
                min={60}
                max={43200}
                step={1}
                suffix="min"
                error={errors.backupIntervalMinutes?.message}
              />
            </SettingsRow>

            <SettingsRow
              htmlFor="backupRetention"
              label="Backup retention"
              description="Keep the most recent N backups. Range 1–100. Default: 7."
            >
              <NumberField
                id="backupRetention"
                {...register('backupRetention', { valueAsNumber: true })}
                min={1}
                max={100}
                step={1}
                error={errors.backupRetention?.message}
              />
            </SettingsRow>
          </SettingsTable>

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
      )}
    </SettingsSection>
  );
}
