import type { z } from 'zod';
import { ClockIcon, TerminalIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { logLevelSchema, DEFAULT_SETTINGS, generalFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type GeneralFormData = z.infer<typeof generalFormSchema>;

export function GeneralSettingsForm() {
  const { form, mutation, onSubmit } = useSettingsForm<GeneralFormData>({
    schema: generalFormSchema,
    defaultValues: {
      logLevel: DEFAULT_SETTINGS.general.logLevel,
      housekeepingRetentionDays: DEFAULT_SETTINGS.general.housekeepingRetentionDays,
    },
    select: (s: AppSettings) => ({
      logLevel: s.general.logLevel,
      housekeepingRetentionDays: s.general.housekeepingRetentionDays,
    }),
    toPayload: (d) => ({ general: d }),
    successMessage: 'General settings saved',
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-8">
      <SettingsSection
        icon={<ClockIcon className="w-5 h-5 text-primary" />}
        title="Housekeeping"
        description="Automatic database maintenance and cleanup"
      >
        <div>
          <label htmlFor="housekeepingRetentionDays" className="block text-sm font-medium mb-2">Event History Retention (days)</label>
          <input
            id="housekeepingRetentionDays"
            type="number"
            min={1}
            max={365}
            step={1}
            {...register('housekeepingRetentionDays', { valueAsNumber: true })}
            className={errorInputClass(!!errors.housekeepingRetentionDays)}
          />
          {errors.housekeepingRetentionDays && (
            <p className="text-sm text-destructive mt-1">{errors.housekeepingRetentionDays.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Events older than this many days are automatically pruned during the weekly housekeeping job. Valid range: 1–365 days.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<TerminalIcon className="w-5 h-5 text-primary" />}
        title="Logging"
        description="Control server log verbosity"
      >
        <div>
          <label htmlFor="logLevel" className="block text-sm font-medium mb-2">Log Level</label>
          <SelectWithChevron id="logLevel" {...register('logLevel')}>
            {logLevelSchema.options.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </SelectWithChevron>
          <p className="text-sm text-muted-foreground mt-2">
            Set to Debug for detailed diagnostic output, or Error to reduce noise
          </p>
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
      </SettingsSection>
    </form>
  );
}
