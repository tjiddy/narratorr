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
            Periodically search indexers and grab the best result for wanted books
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

      {/* Blacklist TTL */}
      <div>
        <label htmlFor="blacklistTtlDays" className="block text-sm font-medium mb-2">Blacklist TTL (days)</label>
        <input
          id="blacklistTtlDays"
          type="number"
          {...register('search.blacklistTtlDays', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.search?.blacklistTtlDays ? 'border-destructive' : 'border-border'
          }`}
          min={1}
          max={365}
          placeholder="7"
        />
        {errors.search?.blacklistTtlDays && (
          <p className="text-sm text-destructive mt-1">{errors.search.blacklistTtlDays.message}</p>
        )}
        <p className="text-sm text-muted-foreground mt-2">
          How long temporary blacklist entries last before expiring (1-365 days)
        </p>
      </div>

      {/* RSS Sync subsection */}
      <div className="border-t border-border pt-6 mt-6">
        <h4 className="text-sm font-semibold mb-4">RSS Sync</h4>

        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="rssEnabled" className="block text-sm font-medium">Enable RSS Sync</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Poll indexer RSS feeds to discover new releases and upgrades
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input id="rssEnabled" type="checkbox" {...register('rss.enabled')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
          </label>
        </div>

        <div className="mt-4">
          <label htmlFor="rssIntervalMinutes" className="block text-sm font-medium mb-2">RSS Interval (minutes)</label>
          <input
            id="rssIntervalMinutes"
            type="number"
            {...register('rss.intervalMinutes', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.rss?.intervalMinutes ? 'border-destructive' : 'border-border'
            }`}
            min={5}
            max={1440}
            placeholder="30"
          />
          {errors.rss?.intervalMinutes && (
            <p className="text-sm text-destructive mt-1">{errors.rss.intervalMinutes.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            How often to poll RSS feeds (5-1440 minutes)
          </p>
        </div>
      </div>

    </SettingsSection>
  );
}
