import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { SparklesIcon } from '@/components/icons';
import { DEFAULT_SETTINGS, newBookDefaultsFormSchema, type AppSettings } from '../../../shared/schemas.js';
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
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <SettingsSection
      icon={<SparklesIcon className="w-5 h-5 text-primary" />}
      title="When a New Book Is Added"
      description="Defaults applied to newly added books"
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
            <input id="newBookSearchImmediately" type="checkbox" {...register('searchImmediately')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
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
            <input id="newBookMonitorForUpgrades" type="checkbox" {...register('monitorForUpgrades')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
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
