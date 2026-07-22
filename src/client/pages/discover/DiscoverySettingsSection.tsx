import type { z } from 'zod';
import { ZapIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { NumberField } from '@/components/settings/NumberField';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, discoveryFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from '../settings/SettingsSection';

type DiscoveryFormData = z.infer<typeof discoveryFormSchema>;

function pickFormFields(src: typeof DEFAULT_SETTINGS.discovery): DiscoveryFormData {
  return {
    enabled: src.enabled,
    intervalHours: src.intervalHours,
    maxSuggestionsPerAuthor: src.maxSuggestionsPerAuthor,
    expiryDays: src.expiryDays,
  };
}

// Single source of truth for the card name: shared by the guard label and the SettingsSection title.
const CARD_LABEL = 'Discovery';

export function DiscoverySettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<DiscoveryFormData>({
    schema: discoveryFormSchema,
    defaultValues: pickFormFields(DEFAULT_SETTINGS.discovery),
    select: (s: AppSettings) => pickFormFields(s.discovery),
    toPayload: (d) => ({ discovery: d }),
    successMessage: 'Discovery settings saved',
    label: CARD_LABEL,
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Configure recommendation engine settings"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          {/* "Enable discovery", not bare "Discovery" — the section title is already "Discovery"
              and a same-text row label would break every getByText('Discovery') query (RTL throws
              on ambiguous matches) and read redundantly under the header. */}
          <SettingsRow htmlFor="discovery-enabled" label="Enable discovery" description="Automatically generate book recommendations based on your library">
            <ToggleSwitch id="discovery-enabled" {...register('enabled')} />
          </SettingsRow>

          <SettingsRow htmlFor="discovery-interval" label="Refresh interval" description="How often to regenerate recommendations.">
            <NumberField
              id="discovery-interval"
              {...register('intervalHours', { valueAsNumber: true })}
              step={1}
              suffix="hours"
              error={errors.intervalHours?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="discovery-max-per-author" label="Max suggestions per author" description="Cap how many recommendations any single author contributes.">
            <NumberField
              id="discovery-max-per-author"
              {...register('maxSuggestionsPerAuthor', { valueAsNumber: true })}
              step={1}
              error={errors.maxSuggestionsPerAuthor?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="discovery-expiry" label="Suggestion expiry" description="Auto-expire pending suggestions older than this many days.">
            <NumberField
              id="discovery-expiry"
              {...register('expiryDays', { valueAsNumber: true })}
              step={1}
              suffix="days"
              error={errors.expiryDays?.message}
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
    </SettingsSection>
  );
}
