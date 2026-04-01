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
import { protocolPreferenceSchema, DEFAULT_SETTINGS, qualityFilteringFormSchema } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const PROTOCOL_LABELS: Record<string, string> = {
  none: 'No Preference',
  usenet: 'Prefer Usenet',
  torrent: 'Prefer Torrent',
};

type QualityFormData = z.infer<typeof qualityFilteringFormSchema>;

export function QualitySettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<QualityFormData>({
    defaultValues: DEFAULT_SETTINGS.quality,
    resolver: zodResolver(qualityFilteringFormSchema),
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
      description="Quality filtering and protocol preferences"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div>
          <label htmlFor="grabFloor" className="block text-sm font-medium mb-2">MB/hr Grab Minimum</label>
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
