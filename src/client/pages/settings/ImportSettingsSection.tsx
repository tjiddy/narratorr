import type { z } from 'zod';
import { PackageIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { errorInputClass } from '@/components/settings/formStyles';
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

  // eslint-disable-next-line react-hooks/incompatible-library
  const deleteAfterImport = watch('deleteAfterImport') as boolean;

  return (
    <SettingsSection
      icon={<PackageIcon className="w-5 h-5 text-primary" />}
      title="Import"
      description="Configure post-download import behavior"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="deleteAfterImport" className="block text-sm font-medium">Delete After Import</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Remove torrent from download client after files are imported
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="deleteAfterImport" {...register('deleteAfterImport')} />
          </label>
        </div>

        <div>
          <label htmlFor="minSeedTime" className="block text-sm font-medium mb-2">Minimum Seed Time (minutes)</label>
          <input
            id="minSeedTime"
            type="number"
            {...register('minSeedTime', { valueAsNumber: true })}
            disabled={!deleteAfterImport}
            className={`${errorInputClass(!!errors.minSeedTime)} disabled:cursor-not-allowed disabled:opacity-50`}
            min={0}
            placeholder="60"
          />
          {errors.minSeedTime && (
            <p className="text-sm text-destructive mt-1">{errors.minSeedTime.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            How long to seed before removing the torrent (only applies when delete after import is enabled)
          </p>
        </div>

        <div>
          <label htmlFor="minSeedRatio" className="block text-sm font-medium mb-2">Minimum Seed Ratio</label>
          <input
            id="minSeedRatio"
            type="number"
            {...register('minSeedRatio', { valueAsNumber: true })}
            disabled={!deleteAfterImport}
            className={`${errorInputClass(!!errors.minSeedRatio)} disabled:cursor-not-allowed disabled:opacity-50`}
            min={0}
            step={0.1}
            placeholder="0"
          />
          {errors.minSeedRatio && (
            <p className="text-sm text-destructive mt-1">{errors.minSeedRatio.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Minimum upload ratio before removing the torrent. Set to 0 to disable (only applies when delete after import is enabled)
          </p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="redownloadFailed" className="block text-sm font-medium">Redownload Failed</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Automatically search for and attempt to download a different release when a download fails
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="redownloadFailed" {...register('redownloadFailed')} />
          </label>
        </div>

        <div>
          <label htmlFor="minFreeSpaceGB" className="block text-sm font-medium mb-2">Minimum Free Space (GB)</label>
          <input
            id="minFreeSpaceGB"
            type="number"
            {...register('minFreeSpaceGB', { valueAsNumber: true })}
            className={errorInputClass(!!errors.minFreeSpaceGB)}
            min={0}
            step={1}
            placeholder="5"
          />
          {errors.minFreeSpaceGB && (
            <p className="text-sm text-destructive mt-1">{errors.minFreeSpaceGB.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Block imports when free disk space is below this threshold. Set to 0 to disable.
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
      </form>
    </SettingsSection>
  );
}
