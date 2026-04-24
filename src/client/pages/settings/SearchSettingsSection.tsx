import { z } from 'zod';
import { SearchIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { errorInputClass as inputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { protocolPreferenceSchema, searchPrioritySchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const PROTOCOL_LABELS: Record<string, string> = { none: 'No Preference', usenet: 'Prefer Usenet', torrent: 'Prefer Torrent' };
const PRIORITY_LABELS: Record<string, string> = { quality: 'Audio Quality', accuracy: 'Narrator Accuracy' };

const searchFormSchema = z.object({
  searchEnabled: z.boolean(),
  searchIntervalMinutes: z.number().int().min(5).max(1440),
  searchPriority: searchPrioritySchema,
  protocolPreference: protocolPreferenceSchema,
  blacklistTtlDays: z.number().int().min(1).max(365),
  rssEnabled: z.boolean(),
  rssIntervalMinutes: z.number().int().min(5).max(1440),
});

type SearchFormData = z.infer<typeof searchFormSchema>;

function toFormData(settings: AppSettings): SearchFormData {
  return {
    searchEnabled: settings.search.enabled,
    searchIntervalMinutes: settings.search.intervalMinutes,
    searchPriority: settings.search.searchPriority,
    protocolPreference: settings.quality.protocolPreference,
    blacklistTtlDays: settings.search.blacklistTtlDays,
    rssEnabled: settings.rss.enabled,
    rssIntervalMinutes: settings.rss.intervalMinutes,
  };
}

function toPayload(data: SearchFormData) {
  return {
    search: {
      enabled: data.searchEnabled,
      intervalMinutes: data.searchIntervalMinutes,
      blacklistTtlDays: data.blacklistTtlDays,
      searchPriority: data.searchPriority,
    },
    rss: {
      enabled: data.rssEnabled,
      intervalMinutes: data.rssIntervalMinutes,
    },
    quality: {
      protocolPreference: data.protocolPreference,
    },
  };
}

export function SearchSettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<SearchFormData>({
    schema: searchFormSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Search settings saved',
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<SearchIcon className="w-5 h-5 text-primary" />}
      title="Search"
      description="Automatic searching for wanted books"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="searchEnabled" className="block text-sm font-medium">Enable Scheduled Search</label>
            <p className="text-sm text-muted-foreground mt-0.5">Periodically search indexers and grab the best result for wanted books</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="searchEnabled" {...register('searchEnabled')} />
          </label>
        </div>

        <div>
          <label htmlFor="searchIntervalMinutes" className="block text-sm font-medium mb-2">Search Interval (minutes)</label>
          <input
            id="searchIntervalMinutes"
            type="number"
            {...register('searchIntervalMinutes', { valueAsNumber: true })}
            className={inputClass(!!errors.searchIntervalMinutes)}
            min={5}
            max={1440}
            step={1}
            placeholder="360"
          />
          {errors.searchIntervalMinutes && (
            <p className="text-sm text-destructive mt-1">{errors.searchIntervalMinutes.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">How often to search for new releases (5-1440 minutes)</p>
        </div>

        <div>
          <label htmlFor="blacklistTtlDays" className="block text-sm font-medium mb-2">Blacklist TTL (days)</label>
          <input
            id="blacklistTtlDays"
            type="number"
            {...register('blacklistTtlDays', { valueAsNumber: true })}
            className={inputClass(!!errors.blacklistTtlDays)}
            min={1}
            max={365}
            step={1}
            placeholder="7"
          />
          {errors.blacklistTtlDays && (
            <p className="text-sm text-destructive mt-1">{errors.blacklistTtlDays.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">How long temporary blacklist entries last before expiring (1-365 days)</p>
        </div>

        <div>
          <label htmlFor="searchPriority" className="block text-sm font-medium mb-2">Search Priority</label>
          <SelectWithChevron id="searchPriority" {...register('searchPriority')}>
            {searchPrioritySchema.options.map((prio) => (
              <option key={prio} value={prio}>
                {PRIORITY_LABELS[prio] ?? prio}
              </option>
            ))}
          </SelectWithChevron>
          <p className="text-sm text-muted-foreground mt-2"><span className="font-medium text-foreground/70">Audio Quality:</span> Prioritize higher bitrate releases. May download full cast or alternative narrator editions.</p>
          <p className="text-sm text-muted-foreground mt-0.5"><span className="font-medium text-foreground/70">Narrator Accuracy:</span> Prioritize releases matching the narrator from metadata. May result in lower quality audio.</p>
        </div>

        <div>
          <label htmlFor="protocolPreference" className="block text-sm font-medium mb-2">Protocol Preference</label>
          <SelectWithChevron id="protocolPreference" {...register('protocolPreference')}>
            {protocolPreferenceSchema.options.map((pref) => (
              <option key={pref} value={pref}>
                {PROTOCOL_LABELS[pref] ?? pref}
              </option>
            ))}
          </SelectWithChevron>
          <p className="text-sm text-muted-foreground mt-2">Preferred download protocol. Affects result ordering but does not exclude results.</p>
        </div>

        {/* RSS Sync subsection */}
        <div className="border-t border-border pt-6 mt-6">
          <h4 className="text-sm font-semibold mb-4">RSS Sync</h4>

          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="rssEnabled" className="block text-sm font-medium">Enable RSS Sync</label>
              <p className="text-sm text-muted-foreground mt-0.5">Poll indexer RSS feeds to discover new releases and upgrades</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <ToggleSwitch id="rssEnabled" {...register('rssEnabled')} />
            </label>
          </div>

          <div className="mt-4">
            <label htmlFor="rssIntervalMinutes" className="block text-sm font-medium mb-2">RSS Interval (minutes)</label>
            <input
              id="rssIntervalMinutes"
              type="number"
              {...register('rssIntervalMinutes', { valueAsNumber: true })}
              className={inputClass(!!errors.rssIntervalMinutes)}
              min={5}
              max={1440}
              step={1}
              placeholder="30"
            />
            {errors.rssIntervalMinutes && (
              <p className="text-sm text-destructive mt-1">{errors.rssIntervalMinutes.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">How often to poll RSS feeds (5-1440 minutes)</p>
          </div>
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
