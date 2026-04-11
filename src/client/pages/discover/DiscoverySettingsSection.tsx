import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { ZapIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { DEFAULT_SETTINGS, discoveryFormSchema } from '../../../shared/schemas.js';
import { SettingsSection } from '../settings/SettingsSection';

type DiscoveryFormData = z.infer<typeof discoveryFormSchema>;

export function DiscoverySettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const pickFormFields = (src: typeof DEFAULT_SETTINGS.discovery): DiscoveryFormData => ({
    enabled: src.enabled,
    intervalHours: src.intervalHours,
    maxSuggestionsPerAuthor: src.maxSuggestionsPerAuthor,
    expiryDays: src.expiryDays,
    snoozeDays: src.snoozeDays,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<DiscoveryFormData>({
    defaultValues: pickFormFields(DEFAULT_SETTINGS.discovery),
    resolver: zodResolver(discoveryFormSchema),
  });

  useEffect(() => {
    if (settings?.discovery && !isDirty) {
      reset(pickFormFields(settings.discovery));
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
      toast.error(getErrorMessage(err, 'Failed to save settings'));
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
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="discovery-enabled" className="cursor-pointer">
            <span className="text-sm font-medium">Enable Discovery</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automatically generate book recommendations based on your library
            </p>
          </label>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="discovery-enabled" {...register('enabled')} />
          </label>
        </div>

        {/* Refresh Interval */}
        <div>
          <label htmlFor="discovery-interval" className="text-sm font-medium">
            Refresh Interval (hours)
          </label>
          <input
            id="discovery-interval"
            type="number"
            {...register('intervalHours', { valueAsNumber: true })}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus-ring"
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
            className="mt-1 w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus-ring"
          />
          {errors.maxSuggestionsPerAuthor && (
            <p className="text-xs text-destructive mt-1">{errors.maxSuggestionsPerAuthor.message}</p>
          )}
        </div>

        {/* Suggestion Expiry */}
        <div>
          <label htmlFor="discovery-expiry" className="text-sm font-medium">
            Suggestion Expiry (days)
          </label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Auto-expire pending suggestions older than this many days
          </p>
          <input
            id="discovery-expiry"
            type="number"
            {...register('expiryDays', { valueAsNumber: true })}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus-ring"
          />
          {errors.expiryDays && (
            <p className="text-xs text-destructive mt-1">{errors.expiryDays.message}</p>
          )}
        </div>

        {/* Default Snooze Duration */}
        <div>
          <label htmlFor="discovery-snooze" className="text-sm font-medium">
            Default Snooze Duration (days)
          </label>
          <p className="text-xs text-muted-foreground mt-0.5">
            How long snoozed suggestions stay hidden before resurfacing
          </p>
          <input
            id="discovery-snooze"
            type="number"
            {...register('snoozeDays', { valueAsNumber: true })}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus-ring"
          />
          {errors.snoozeDays && (
            <p className="text-xs text-destructive mt-1">{errors.snoozeDays.message}</p>
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
