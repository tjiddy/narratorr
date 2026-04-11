import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { SparklesIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { DEFAULT_SETTINGS, newBookDefaultsFormSchema } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type NewBookDefaultsFormData = z.infer<typeof newBookDefaultsFormSchema>;

export function NewBookDefaultsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { isDirty } } = useForm<NewBookDefaultsFormData>({
    defaultValues: { searchImmediately: DEFAULT_SETTINGS.quality.searchImmediately, monitorForUpgrades: DEFAULT_SETTINGS.quality.monitorForUpgrades },
    resolver: zodResolver(newBookDefaultsFormSchema),
  });

  useEffect(() => {
    if (settings?.quality && !isDirty) {
      reset({
        searchImmediately: settings.quality.searchImmediately,
        monitorForUpgrades: settings.quality.monitorForUpgrades,
      });
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: NewBookDefaultsFormData) => api.updateSettings({ quality: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('New book defaults saved');
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, 'Failed to save settings'));
    },
  });

  return (
    <SettingsSection
      icon={<SparklesIcon className="w-5 h-5 text-primary" />}
      title="When a New Book Is Added"
      description="Applied when books are added manually or via import lists, RSS sync, and discovery"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
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
