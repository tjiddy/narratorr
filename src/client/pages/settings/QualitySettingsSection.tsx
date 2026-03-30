import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ZapIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { protocolPreferenceSchema, DEFAULT_SETTINGS, qualityFormSchema } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const PROTOCOL_LABELS: Record<string, string> = {
  none: 'No Preference',
  usenet: 'Prefer Usenet',
  torrent: 'Prefer Torrent',
};

type QualityFormData = z.infer<typeof qualityFormSchema>;

// eslint-disable-next-line max-lines-per-function -- linear form with 7 quality fields
export function QualitySettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<QualityFormData>({
    defaultValues: DEFAULT_SETTINGS.quality,
    resolver: zodResolver(qualityFormSchema),
  });

  useEffect(() => {
    if (settings?.quality && !isDirty) {
      reset(settings.quality);
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: QualityFormData) => api.updateSettings({ quality: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Quality settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Quality"
      description="Quality filtering, upgrade monitoring, and protocol preferences"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div>
          <label htmlFor="grabFloor" className="block text-sm font-medium mb-2">MB/hr Grab Floor</label>
          <input
            id="grabFloor"
            type="number"
            {...register('grabFloor', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
              errors.grabFloor ? 'border-destructive' : 'border-border'
            }`}
            min={0}
            step="any"
            placeholder="0"
          />
          {errors.grabFloor && (
            <p className="text-sm text-destructive mt-1">{errors.grabFloor.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Minimum MB/hr to accept. Releases below this threshold are hidden from search results. Set to 0 to disable.
          </p>
        </div>

        <div>
          <label htmlFor="protocolPreference" className="block text-sm font-medium mb-2">Protocol Preference</label>
          <SelectWithChevron id="protocolPreference" {...register('protocolPreference')}>
            {protocolPreferenceSchema.options.map((pref) => (
              <option key={pref} value={pref}>
                {PROTOCOL_LABELS[pref] ?? pref}
              </option>
            ))}
          </SelectWithChevron>
          <p className="text-sm text-muted-foreground mt-2">
            Preferred download protocol. Affects result ordering but does not exclude results.
          </p>
        </div>

        <div>
          <label htmlFor="minSeeders" className="block text-sm font-medium mb-2">Minimum Seeders</label>
          <input
            id="minSeeders"
            type="number"
            {...register('minSeeders', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
              errors.minSeeders ? 'border-destructive' : 'border-border'
            }`}
            min={0}
            step={1}
            placeholder="0"
          />
          {errors.minSeeders && (
            <p className="text-sm text-destructive mt-1">{errors.minSeeders.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Torrent results with fewer seeders are hidden. Does not affect Usenet results. Set to 0 to disable.
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

        <div className="space-y-4 pt-4 mt-2 border-t border-border/50">
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Defaults for New Books</h4>

          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="qualitySearchImmediately" className="block text-sm font-medium">Search Immediately</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Trigger a search as soon as a book is added
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input id="qualitySearchImmediately" type="checkbox" {...register('searchImmediately')} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="qualityMonitorForUpgrades" className="block text-sm font-medium">Monitor for Upgrades</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Include new books in scheduled upgrade searches
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input id="qualityMonitorForUpgrades" type="checkbox" {...register('monitorForUpgrades')} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>
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
