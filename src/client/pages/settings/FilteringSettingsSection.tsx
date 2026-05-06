import { useWatch } from 'react-hook-form';
import { z } from 'zod';
import { GlobeIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { audibleRegionSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { CANONICAL_LANGUAGES, type CanonicalLanguage } from '../../../shared/language-constants.js';
import { SettingsSection } from './SettingsSection';

const REGION_LABELS: Record<string, string> = {
  us: 'United States',
  ca: 'Canada',
  uk: 'United Kingdom',
  au: 'Australia',
  fr: 'France',
  de: 'Germany',
  jp: 'Japan',
  it: 'Italy',
  in: 'India',
  es: 'Spain',
};

const filteringFormSchema = z.object({
  audibleRegion: audibleRegionSchema,
  languages: z.array(z.string()),
  minDurationMinutes: z.number().int().nonnegative(),
  rejectWords: z.string(),
  requiredWords: z.string(),
});

type FilteringFormData = z.infer<typeof filteringFormSchema>;

function toFormData(settings: AppSettings): FilteringFormData {
  return {
    audibleRegion: settings.metadata.audibleRegion,
    languages: [...settings.metadata.languages],
    minDurationMinutes: settings.metadata.minDurationMinutes,
    rejectWords: settings.quality.rejectWords,
    requiredWords: settings.quality.requiredWords,
  };
}

function toPayload(data: FilteringFormData) {
  return {
    metadata: {
      audibleRegion: data.audibleRegion,
      languages: data.languages as CanonicalLanguage[],
      minDurationMinutes: data.minDurationMinutes,
    },
    quality: {
      rejectWords: data.rejectWords,
      requiredWords: data.requiredWords,
    },
  };
}

export function FilteringSettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<FilteringFormData>({
    schema: filteringFormSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Filtering settings saved',
  });

  const { register, handleSubmit, control, setValue, formState: { isDirty } } = form;

  const selectedLanguages = useWatch({ control, name: 'languages' }) ?? [];

  function toggleLanguage(lang: string) {
    const updated = selectedLanguages.includes(lang)
      ? selectedLanguages.filter((l) => l !== lang)
      : [...selectedLanguages, lang];
    setValue('languages', updated, { shouldDirty: true });
  }

  return (
    <SettingsSection
      icon={<GlobeIcon className="w-5 h-5 text-primary" />}
      title="Filtering"
      description="What search results to keep"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div>
          <label htmlFor="audibleRegion" className="block text-sm font-medium mb-2">Region</label>
          <SelectWithChevron id="audibleRegion" {...register('audibleRegion')}>
            {audibleRegionSchema.options.map((region) => (
              <option key={region} value={region}>
                {REGION_LABELS[region] ?? region}
              </option>
            ))}
          </SelectWithChevron>
          <p className="text-sm text-muted-foreground mt-2">
            Select your Audible region for metadata lookups. Affects which catalog is searched for audiobook details, narrators, and cover art.
          </p>
        </div>

        <div>
          <span className="block text-sm font-medium mb-2">Languages</span>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {CANONICAL_LANGUAGES.map((lang) => (
              <label key={lang} className="flex items-center gap-2 text-sm cursor-pointer capitalize">
                <input
                  type="checkbox"
                  checked={selectedLanguages.includes(lang)}
                  onChange={() => toggleLanguage(lang)}
                  className="rounded border-border text-primary focus-ring"
                />
                {lang}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Search results in unselected languages are excluded. Results with no language metadata always pass through. Deselect all for unrestricted search.
          </p>
        </div>

        <div>
          <label htmlFor="minDurationMinutes" className="block text-sm font-medium mb-2">Minimum Duration (minutes)</label>
          <input
            id="minDurationMinutes"
            type="number"
            min={0}
            step={1}
            {...register('minDurationMinutes', { valueAsNumber: true })}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
            placeholder="0"
          />
          <p className="text-sm text-muted-foreground mt-2">
            Filter out promotional excerpts, TTS knockoffs, and supplementary clips. Set to 0 to disable. Recommended: 30 minutes.
          </p>
        </div>

        <div>
          <label htmlFor="rejectWords" className="block text-sm font-medium mb-2">Reject Words</label>
          <input
            id="rejectWords"
            type="text"
            {...register('rejectWords')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
            placeholder="Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged"
          />
          <p className="text-sm text-muted-foreground mt-2">
            Comma-separated words. Releases or metadata results matching any word in title, subtitle, author, narrator, or format type are excluded.
          </p>
        </div>

        <div>
          <label htmlFor="requiredWords" className="block text-sm font-medium mb-2">Required Words</label>
          <input
            id="requiredWords"
            type="text"
            {...register('requiredWords')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
            placeholder="M4B, Unabridged"
          />
          <p className="text-sm text-muted-foreground mt-2">
            Comma-separated words. When set, only releases with titles matching at least one word are shown.
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
