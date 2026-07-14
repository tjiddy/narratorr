import type { z } from 'zod';
import { PackageIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { NumberField } from '@/components/settings/NumberField';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, importSettingsSchema, stripDefaults, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const importFormSchema = stripDefaults(importSettingsSchema);

type ImportFormData = z.infer<typeof importFormSchema>;

export function ImportSettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<ImportFormData>({
    schema: importFormSchema,
    defaultValues: DEFAULT_SETTINGS.import,
    select: (s: AppSettings) => s.import as ImportFormData,
    toPayload: (d) => ({ import: d }),
    successMessage: 'Import settings saved',
  });

  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;

  const deleteAfterImport = watch('deleteAfterImport') as boolean;

  return (
    <SettingsSection
      icon={<PackageIcon className="w-5 h-5 text-primary" />}
      title="Import"
      description="Configure post-download import behavior"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow htmlFor="deleteAfterImport" label="Delete after import" description="Remove torrent from download client after files are imported">
            <ToggleSwitch id="deleteAfterImport" {...register('deleteAfterImport')} />
          </SettingsRow>

          <SettingsRow
            htmlFor="minSeedTime"
            label="Minimum seed time"
            description="How long to seed before removing the torrent — applies only when delete after import is on."
            muted={!deleteAfterImport}
          >
            <NumberField
              id="minSeedTime"
              {...register('minSeedTime', { valueAsNumber: true })}
              disabled={!deleteAfterImport}
              min={0}
              step={1}
              placeholder="60"
              suffix="minutes"
              error={errors.minSeedTime?.message}
            />
          </SettingsRow>

          <SettingsRow
            htmlFor="minSeedRatio"
            label="Minimum seed ratio"
            description="Minimum upload ratio before removing the torrent. Set to 0 to disable — applies only when delete after import is on."
            muted={!deleteAfterImport}
          >
            <NumberField
              id="minSeedRatio"
              {...register('minSeedRatio', { valueAsNumber: true })}
              disabled={!deleteAfterImport}
              min={0}
              step={0.1}
              placeholder="0"
              error={errors.minSeedRatio?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="redownloadFailed" label="Redownload failed" description="Automatically search for and attempt to download a different release when a download fails">
            <ToggleSwitch id="redownloadFailed" {...register('redownloadFailed')} />
          </SettingsRow>

          <SettingsRow htmlFor="minFreeSpaceGB" label="Minimum free space" description="Block imports when free disk space is below this threshold. Set to 0 to disable.">
            <NumberField
              id="minFreeSpaceGB"
              {...register('minFreeSpaceGB', { valueAsNumber: true })}
              min={0}
              step="any"
              placeholder="5"
              suffix="GB"
              error={errors.minFreeSpaceGB?.message}
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
