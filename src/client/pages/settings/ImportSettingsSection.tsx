import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import { PackageIcon } from '@/components/icons';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

interface ImportSettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
}

export function ImportSettingsSection({ register, errors }: ImportSettingsSectionProps) {
  return (
    <SettingsSection
      icon={<PackageIcon className="w-5 h-5 text-primary" />}
      title="Import"
      description="Configure post-download import behavior"
    >
      <div className="flex items-center justify-between">
        <div>
          <label htmlFor="deleteAfterImport" className="block text-sm font-medium">Delete After Import</label>
          <p className="text-sm text-muted-foreground mt-0.5">
            Remove torrent from download client after files are imported
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input id="deleteAfterImport" type="checkbox" {...register('import.deleteAfterImport')} className="sr-only peer" />
          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
        </label>
      </div>

      <div>
        <label htmlFor="minSeedTime" className="block text-sm font-medium mb-2">Minimum Seed Time (minutes)</label>
        <input
          id="minSeedTime"
          type="number"
          {...register('import.minSeedTime', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.import?.minSeedTime ? 'border-destructive' : 'border-border'
          }`}
          min={0}
          placeholder="60"
        />
        {errors.import?.minSeedTime && (
          <p className="text-sm text-destructive mt-1">{errors.import.minSeedTime.message}</p>
        )}
        <p className="text-sm text-muted-foreground mt-2">
          How long to seed before removing the torrent (only applies when delete after import is enabled)
        </p>
      </div>

      <div>
        <label htmlFor="minFreeSpaceGB" className="block text-sm font-medium mb-2">Minimum Free Space (GB)</label>
        <input
          id="minFreeSpaceGB"
          type="number"
          {...register('import.minFreeSpaceGB', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.import?.minFreeSpaceGB ? 'border-destructive' : 'border-border'
          }`}
          min={0}
          step={1}
          placeholder="5"
        />
        {errors.import?.minFreeSpaceGB && (
          <p className="text-sm text-destructive mt-1">{errors.import.minFreeSpaceGB.message}</p>
        )}
        <p className="text-sm text-muted-foreground mt-2">
          Block imports when free disk space is below this threshold. Set to 0 to disable.
        </p>
      </div>
    </SettingsSection>
  );
}
