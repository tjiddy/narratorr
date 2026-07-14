import { useWatch } from 'react-hook-form';
import type { z } from 'zod';
import { GlobeIcon } from '@/components/icons';
import { NumberField } from '@/components/settings/NumberField';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { inputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { filteringFormSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { CANONICAL_LANGUAGES, type CanonicalLanguage } from '../../../shared/language-constants.js';
import { SettingsSection } from './SettingsSection';

type FilteringFormData = z.infer<typeof filteringFormSchema>;

function toFormData(settings: AppSettings): FilteringFormData {
  return {
    languages: [...settings.metadata.languages],
    minDurationMinutes: settings.metadata.minDurationMinutes,
    rejectWords: settings.quality.rejectWords,
    requiredWords: settings.quality.requiredWords,
  };
}

function toPayload(data: FilteringFormData) {
  return {
    metadata: {
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

  const { register, handleSubmit, control, setValue, formState: { errors, isDirty } } = form;

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
        <SettingsTable>
          <SettingsRow
            layout="stacked"
            label="Languages"
            description="Search results in unselected languages are excluded. Results with no language metadata always pass through. Deselect all for unrestricted search."
          >
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
          </SettingsRow>

          <SettingsRow htmlFor="minDurationMinutes" label="Minimum duration" description="Filter out promotional excerpts, TTS knockoffs, and supplementary clips. Set to 0 to disable. Recommended: 30 minutes.">
            <NumberField
              id="minDurationMinutes"
              {...register('minDurationMinutes', { valueAsNumber: true })}
              min={0}
              step={1}
              placeholder="0"
              suffix="minutes"
              error={errors.minDurationMinutes?.message}
            />
          </SettingsRow>

          <SettingsRow
            layout="stacked"
            htmlFor="rejectWords"
            label="Reject words"
            description="Comma-separated words. Releases or metadata results matching any word in title, subtitle, author, narrator, or format type are excluded."
          >
            <input
              id="rejectWords"
              type="text"
              {...register('rejectWords')}
              className={inputClass}
              placeholder="Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged"
            />
          </SettingsRow>

          <SettingsRow
            layout="stacked"
            htmlFor="requiredWords"
            label="Required words"
            description="Comma-separated words. When set, only releases with titles matching at least one word are shown."
          >
            <input
              id="requiredWords"
              type="text"
              {...register('requiredWords')}
              className={inputClass}
              placeholder="M4B, Unabridged"
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
