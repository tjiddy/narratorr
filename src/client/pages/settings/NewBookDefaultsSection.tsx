import type { z } from 'zod';
import { SparklesIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, newBookDefaultsFormSchema, type AppSettings } from '@shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type NewBookDefaultsFormData = z.infer<typeof newBookDefaultsFormSchema>;

const CARD_LABEL = 'When a New Book Is Added';

export function NewBookDefaultsSection() {
  const { form, mutation, onSubmit, settingsError, refetchSettings } = useSettingsForm<NewBookDefaultsFormData>({
    schema: newBookDefaultsFormSchema,
    defaultValues: { searchImmediately: DEFAULT_SETTINGS.quality.searchImmediately },
    select: (s: AppSettings) => ({
      searchImmediately: s.quality.searchImmediately,
    }),
    toPayload: (d) => ({ quality: d }),
    successMessage: 'New book defaults saved',
    label: CARD_LABEL,
  });

  const { register, handleSubmit, formState: { isDirty } } = form;

  return (
    <SettingsSection
      icon={<SparklesIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Applied when books are added manually or via import lists or discovery"
    >
      {/* An off Search immediately toggle reads as a deliberate "don't search on add";
          it is the schema default, which a failed read never observed. */}
      {settingsError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load new book defaults.</p>
          <button
            type="button"
            onClick={refetchSettings}
            aria-label="Retry loading new book defaults"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-4">
          <SettingsTable>
            <SettingsRow htmlFor="newBookSearchImmediately" label="Search immediately" description="Trigger a search as soon as a book is added">
              <ToggleSwitch id="newBookSearchImmediately" {...register('searchImmediately')} />
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
      )}
    </SettingsSection>
  );
}
