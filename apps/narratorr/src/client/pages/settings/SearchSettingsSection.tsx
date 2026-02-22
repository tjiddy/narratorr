import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import { SearchIcon } from '@/components/icons';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

interface SearchSettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
}

export function SearchSettingsSection({ register, errors }: SearchSettingsSectionProps) {
  return (
    <SettingsSection
      icon={<SearchIcon className="w-5 h-5 text-primary" />}
      title="Search"
      description="Automatic searching for wanted books"
    >
      <div className="flex items-center justify-between">
        <div>
          <label htmlFor="searchEnabled" className="block text-sm font-medium">Enable Scheduled Search</label>
          <p className="text-sm text-muted-foreground mt-0.5">
            Periodically search indexers for books in your wanted list
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input id="searchEnabled" type="checkbox" {...register('search.enabled')} className="sr-only peer" />
          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
        </label>
      </div>

      <div>
        <label htmlFor="searchIntervalMinutes" className="block text-sm font-medium mb-2">Search Interval (minutes)</label>
        <input
          id="searchIntervalMinutes"
          type="number"
          {...register('search.intervalMinutes', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.search?.intervalMinutes ? 'border-destructive' : 'border-border'
          }`}
          min={5}
          max={1440}
          placeholder="360"
        />
        {errors.search?.intervalMinutes && (
          <p className="text-sm text-destructive mt-1">{errors.search.intervalMinutes.message}</p>
        )}
        <p className="text-sm text-muted-foreground mt-2">
          How often to search for new releases (5-1440 minutes)
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <label htmlFor="searchAutoGrab" className="block text-sm font-medium">Auto-Grab Best Result</label>
          <p className="text-sm text-muted-foreground mt-0.5">
            Automatically grab the best result (most seeders) when a match is found
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input id="searchAutoGrab" type="checkbox" {...register('search.autoGrab')} className="sr-only peer" />
          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
        </label>
      </div>
    </SettingsSection>
  );
}
