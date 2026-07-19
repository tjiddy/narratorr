import type { z } from 'zod';
import { ZapIcon } from '@/components/icons';
import { NumberField } from '@/components/settings/NumberField';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, qualityFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const qualityGateFormSchema = qualityFormSchema.pick({ grabFloor: true, minSeeders: true, minDownloadSize: true, maxDownloadSize: true });

type QualityGateFormData = z.infer<typeof qualityGateFormSchema>;

// Single source of truth for the card name: shared by the guard label and the SettingsSection title.
const CARD_LABEL = 'Quality';

export function QualitySettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<QualityGateFormData>({
    schema: qualityGateFormSchema,
    defaultValues: {
      grabFloor: DEFAULT_SETTINGS.quality.grabFloor,
      minSeeders: DEFAULT_SETTINGS.quality.minSeeders,
      minDownloadSize: DEFAULT_SETTINGS.quality.minDownloadSize,
      maxDownloadSize: DEFAULT_SETTINGS.quality.maxDownloadSize,
    },
    select: (s: AppSettings) => ({
      grabFloor: s.quality.grabFloor,
      minSeeders: s.quality.minSeeders,
      minDownloadSize: s.quality.minDownloadSize,
      maxDownloadSize: s.quality.maxDownloadSize,
    }),
    toPayload: (d) => ({ quality: d }),
    successMessage: 'Quality settings saved',
    label: CARD_LABEL,
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Minimum bar to grab"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow htmlFor="grabFloor" label="Grab minimum" description="Minimum MB/hr to accept. Releases below this threshold are hidden from search results. Set to 0 to disable.">
            <NumberField
              id="grabFloor"
              {...register('grabFloor', { valueAsNumber: true })}
              min={0}
              step="any"
              placeholder="0"
              suffix="MB/hr"
              error={errors.grabFloor?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="minSeeders" label="Minimum seeders" description="Torrent results with fewer seeders are hidden. Does not affect Usenet results. Set to 0 to disable.">
            <NumberField
              id="minSeeders"
              {...register('minSeeders', { valueAsNumber: true })}
              min={0}
              step={1}
              placeholder="0"
              error={errors.minSeeders?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="minDownloadSize" label="Min download size" description="Minimum download size in MB. Filters out tracker-test uploads, single-track previews, and corrupted partial releases. Set to 0 to disable.">
            <NumberField
              id="minDownloadSize"
              {...register('minDownloadSize', { valueAsNumber: true })}
              min={0}
              step="any"
              placeholder="50"
              suffix="MB"
              error={errors.minDownloadSize?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="maxDownloadSize" label="Max download size" description="Maximum download size in GB. Releases larger than this are hidden from search results. Set to 0 to disable.">
            <NumberField
              id="maxDownloadSize"
              {...register('maxDownloadSize', { valueAsNumber: true })}
              min={0}
              step="any"
              placeholder="0"
              suffix="GB"
              error={errors.maxDownloadSize?.message}
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
