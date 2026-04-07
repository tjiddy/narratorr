import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { GlobeIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
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
  rejectWords: z.string(),
  requiredWords: z.string(),
});

type FilteringFormData = z.infer<typeof filteringFormSchema>;

function toFormData(settings: AppSettings): FilteringFormData {
  return {
    audibleRegion: settings.metadata.audibleRegion,
    languages: [...settings.metadata.languages],
    rejectWords: settings.quality.rejectWords,
    requiredWords: settings.quality.requiredWords,
  };
}

function toPayload(data: FilteringFormData) {
  return {
    metadata: { audibleRegion: data.audibleRegion, languages: data.languages as CanonicalLanguage[] },
    quality: {
      rejectWords: data.rejectWords,
      requiredWords: data.requiredWords,
    },
  };
}

export function FilteringSettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, control, setValue, formState: { isDirty } } = useForm<FilteringFormData>({
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    resolver: zodResolver(filteringFormSchema),
  });

  useEffect(() => {
    if (settings && !isDirty) {
      reset(toFormData(settings));
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: FilteringFormData) => api.updateSettings(toPayload(data)),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Filtering settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

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
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
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
          <label htmlFor="rejectWords" className="block text-sm font-medium mb-2">Reject Words</label>
          <input
            id="rejectWords"
            type="text"
            {...register('rejectWords')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
            placeholder="German, Abridged, Full Cast, Dramatized"
          />
          <p className="text-sm text-muted-foreground mt-2">
            Comma-separated words. Releases with titles matching any word are excluded from search results.
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
