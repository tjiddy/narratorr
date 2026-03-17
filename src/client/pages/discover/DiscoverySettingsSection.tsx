import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ZapIcon } from '@/components/icons';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from '../settings/SettingsSection';

const discoveryFormSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
  maxSuggestionsPerAuthor: z.number().int().min(1).max(50),
});

type DiscoveryFormData = AppSettings['discovery'];

export function DiscoverySettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<DiscoveryFormData>({
    defaultValues: DEFAULT_SETTINGS.discovery,
    resolver: zodResolver(discoveryFormSchema),
  });

  useEffect(() => {
    if (settings?.discovery && !isDirty) {
      reset(settings.discovery);
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: DiscoveryFormData) => api.updateSettings({ discovery: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Discovery settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Discovery"
      description="Configure recommendation engine settings"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        {/* Enable/Disable Toggle */}
        <label className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium">Enable Discovery</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automatically generate book recommendations based on your library
            </p>
          </div>
          <input
            type="checkbox"
            {...register('enabled')}
            className="w-5 h-5 rounded border-border text-primary focus:ring-primary cursor-pointer"
          />
        </label>

        {/* Refresh Interval */}
        <div>
          <label htmlFor="discovery-interval" className="text-sm font-medium">
            Refresh Interval (hours)
          </label>
          <input
            id="discovery-interval"
            type="number"
            {...register('intervalHours', { valueAsNumber: true })}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {errors.intervalHours && (
            <p className="text-xs text-destructive mt-1">{errors.intervalHours.message}</p>
          )}
        </div>

        {/* Max Suggestions Per Author */}
        <div>
          <label htmlFor="discovery-max-per-author" className="text-sm font-medium">
            Max Suggestions Per Author
          </label>
          <input
            id="discovery-max-per-author"
            type="number"
            {...register('maxSuggestionsPerAuthor', { valueAsNumber: true })}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {errors.maxSuggestionsPerAuthor && (
            <p className="text-xs text-destructive mt-1">{errors.maxSuggestionsPerAuthor.message}</p>
          )}
        </div>

        {/* Save Button — only visible when form is dirty */}
        {isDirty && (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-all focus-ring"
            >
              {mutation.isPending ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </form>
    </SettingsSection>
  );
}
