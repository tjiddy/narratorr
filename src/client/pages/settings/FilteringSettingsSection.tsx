import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { GlobeIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { audibleRegionSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
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
  rejectWords: z.string(),
  requiredWords: z.string(),
  preferredLanguage: z.string(),
});

type FilteringFormData = z.infer<typeof filteringFormSchema>;

function toFormData(settings: AppSettings): FilteringFormData {
  return {
    audibleRegion: settings.metadata.audibleRegion,
    rejectWords: settings.quality.rejectWords,
    requiredWords: settings.quality.requiredWords,
    preferredLanguage: settings.quality.preferredLanguage,
  };
}

function toPayload(data: FilteringFormData) {
  return {
    metadata: { audibleRegion: data.audibleRegion },
    quality: {
      rejectWords: data.rejectWords,
      requiredWords: data.requiredWords,
      preferredLanguage: data.preferredLanguage,
    },
  };
}

export function FilteringSettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { isDirty } } = useForm<FilteringFormData>({
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
          <label htmlFor="preferredLanguage" className="block text-sm font-medium mb-2">Preferred Language</label>
          <input
            id="preferredLanguage"
            type="text"
            {...register('preferredLanguage')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
            placeholder="english"
          />
          <p className="text-sm text-muted-foreground mt-2">
            Preferred language for search results (e.g. english, german, french). Results in other languages are ranked lower but not excluded. Leave empty to disable.
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
