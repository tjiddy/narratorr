import type { z } from 'zod';
import { SearchIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { NumberField } from '@/components/settings/NumberField';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { protocolPreferenceSchema, searchPrioritySchema, searchFormSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const PROTOCOL_LABELS: Record<string, string> = { none: 'No Preference', usenet: 'Prefer Usenet', torrent: 'Prefer Torrent' };
const PRIORITY_LABELS: Record<string, string> = { quality: 'Audio Quality', accuracy: 'Narrator Accuracy' };

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

/** Two-line option explainer for the Search priority row — spans, not <p> (description sits inside a <p>). */
function SearchPriorityDescription() {
  return (
    <>
      <span className="block"><span className="font-medium text-foreground/70">Audio Quality:</span> Prioritize higher bitrate releases. May download full cast or alternative narrator editions.</span>
      <span className="block mt-0.5"><span className="font-medium text-foreground/70">Narrator Accuracy:</span> Prioritize releases matching the narrator from metadata. May result in lower quality audio.</span>
    </>
  );
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
        <SettingsTable>
          <SettingsRow htmlFor="searchEnabled" label="Scheduled search" description="Periodically search indexers and grab the best result for wanted books">
            <ToggleSwitch id="searchEnabled" {...register('searchEnabled')} />
          </SettingsRow>

          <SettingsRow htmlFor="searchIntervalMinutes" label="Search interval" description="How often to search for new releases (5-1440 minutes).">
            <NumberField
              id="searchIntervalMinutes"
              {...register('searchIntervalMinutes', { valueAsNumber: true })}
              min={5}
              max={1440}
              step={1}
              placeholder="360"
              suffix="minutes"
              error={errors.searchIntervalMinutes?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="blacklistTtlDays" label="Blacklist TTL" description="How long temporary blacklist entries last before expiring (1-365 days).">
            <NumberField
              id="blacklistTtlDays"
              {...register('blacklistTtlDays', { valueAsNumber: true })}
              min={1}
              max={365}
              step={1}
              placeholder="7"
              suffix="days"
              error={errors.blacklistTtlDays?.message}
            />
          </SettingsRow>

          <SettingsRow htmlFor="searchPriority" label="Search priority" description={<SearchPriorityDescription />}>
            <div className="w-56">
              <SelectWithChevron id="searchPriority" {...register('searchPriority')}>
                {searchPrioritySchema.options.map((prio) => (
                  <option key={prio} value={prio}>{PRIORITY_LABELS[prio] ?? prio}</option>
                ))}
              </SelectWithChevron>
            </div>
          </SettingsRow>

          <SettingsRow htmlFor="protocolPreference" label="Protocol preference" description="Preferred download protocol. Affects result ordering but does not exclude results.">
            <div className="w-56">
              <SelectWithChevron id="protocolPreference" {...register('protocolPreference')}>
                {protocolPreferenceSchema.options.map((pref) => (
                  <option key={pref} value={pref}>{PROTOCOL_LABELS[pref] ?? pref}</option>
                ))}
              </SelectWithChevron>
            </div>
          </SettingsRow>
        </SettingsTable>

        <div>
          <h3 className="text-sm font-semibold mb-3">RSS Sync</h3>
          <SettingsTable>
            <SettingsRow htmlFor="rssEnabled" label="RSS sync" description="Poll indexer RSS feeds to discover releases for wanted books">
              <ToggleSwitch id="rssEnabled" {...register('rssEnabled')} />
            </SettingsRow>

            <SettingsRow htmlFor="rssIntervalMinutes" label="RSS interval" description="How often to poll RSS feeds (5-1440 minutes).">
              <NumberField
                id="rssIntervalMinutes"
                {...register('rssIntervalMinutes', { valueAsNumber: true })}
                min={5}
                max={1440}
                step={1}
                placeholder="30"
                suffix="minutes"
                error={errors.rssIntervalMinutes?.message}
              />
            </SettingsRow>
          </SettingsTable>
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
