import type { z } from 'zod';
import { ClockIcon, TerminalIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { NumberField } from '@/components/settings/NumberField';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { logLevelSchema, DEFAULT_SETTINGS, generalFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

// Housekeeping and Logging write disjoint slices of the `general` category, so each is its own
// card with its own dirty-gated Save — no page-spanning form. The backend patches category
// subsets ({ ...existing, ...partial }), so saving one slice never clobbers the other. The
// per-form schemas are picked from the shared generalFormSchema so bounds can't drift.
const housekeepingSchema = generalFormSchema.pick({ housekeepingRetentionDays: true });
const loggingSchema = generalFormSchema.pick({ logLevel: true });
type HousekeepingFormData = z.infer<typeof housekeepingSchema>;
type LoggingFormData = z.infer<typeof loggingSchema>;

function SaveButton({ pending }: { pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in"
    >
      {pending ? 'Saving...' : 'Save'}
    </button>
  );
}

function HousekeepingForm() {
  const { form, mutation, onSubmit } = useSettingsForm<HousekeepingFormData>({
    schema: housekeepingSchema,
    defaultValues: { housekeepingRetentionDays: DEFAULT_SETTINGS.general.housekeepingRetentionDays },
    select: (s: AppSettings) => ({ housekeepingRetentionDays: s.general.housekeepingRetentionDays }),
    toPayload: (d) => ({ general: d }),
    successMessage: 'General settings saved',
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<ClockIcon className="w-5 h-5 text-primary" />}
      title="Housekeeping"
      description="Automatic database maintenance and cleanup"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow
            htmlFor="housekeepingRetentionDays"
            label="Event history retention"
            description="Events older than this are pruned during the weekly housekeeping job. Range 1–365 days."
          >
            <NumberField
              id="housekeepingRetentionDays"
              {...register('housekeepingRetentionDays', { valueAsNumber: true })}
              min={1}
              max={365}
              step={1}
              suffix="days"
              error={errors.housekeepingRetentionDays?.message}
            />
          </SettingsRow>
        </SettingsTable>
        {isDirty && <SaveButton pending={mutation.isPending} />}
      </form>
    </SettingsSection>
  );
}

function LoggingForm() {
  const { form, mutation, onSubmit } = useSettingsForm<LoggingFormData>({
    schema: loggingSchema,
    defaultValues: { logLevel: DEFAULT_SETTINGS.general.logLevel },
    select: (s: AppSettings) => ({ logLevel: s.general.logLevel }),
    toPayload: (d) => ({ general: d }),
    successMessage: 'General settings saved',
  });

  const { register, handleSubmit, formState: { isDirty } } = form;

  return (
    <SettingsSection
      icon={<TerminalIcon className="w-5 h-5 text-primary" />}
      title="Logging"
      description="Control server log verbosity"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow
            htmlFor="logLevel"
            label="Log level"
            description="Set to Debug for detailed diagnostic output, or Error to reduce noise."
          >
            <div className="w-56">
              <SelectWithChevron id="logLevel" {...register('logLevel')}>
                {logLevelSchema.options.map((level) => (
                  <option key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </SelectWithChevron>
            </div>
          </SettingsRow>
        </SettingsTable>
        {isDirty && <SaveButton pending={mutation.isPending} />}
      </form>
    </SettingsSection>
  );
}

export function GeneralSettingsForm() {
  return (
    <>
      <HousekeepingForm />
      <LoggingForm />
    </>
  );
}
