import type { z } from 'zod';
import { SparklesIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, newBookDefaultsFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type NewBookDefaultsFormData = z.infer<typeof newBookDefaultsFormSchema>;

export function NewBookDefaultsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<NewBookDefaultsFormData>({
    schema: newBookDefaultsFormSchema,
    defaultValues: { searchImmediately: DEFAULT_SETTINGS.quality.searchImmediately, monitorForUpgrades: DEFAULT_SETTINGS.quality.monitorForUpgrades },
    select: (s: AppSettings) => ({
      searchImmediately: s.quality.searchImmediately,
      monitorForUpgrades: s.quality.monitorForUpgrades,
    }),
    toPayload: (d) => ({ quality: d }),
    successMessage: 'New book defaults saved',
  });

  const { register, handleSubmit, formState: { isDirty } } = form;

  return (
    <SettingsSection
      icon={<SparklesIcon className="w-5 h-5 text-primary" />}
      title="When a New Book Is Added"
      description="Applied when books are added manually or via import lists, RSS sync, and discovery"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="newBookSearchImmediately" className="block text-sm font-medium">Search Immediately</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Trigger a search as soon as a book is added
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="newBookSearchImmediately" {...register('searchImmediately')} />
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="newBookMonitorForUpgrades" className="block text-sm font-medium">Monitor for Upgrades</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Include new books in scheduled upgrade searches
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="newBookMonitorForUpgrades" {...register('monitorForUpgrades')} />
          </label>
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
