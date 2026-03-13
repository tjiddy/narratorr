import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { HeadphonesIcon } from '@/components/icons';
import { audibleRegionSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const metadataFormSchema = z.object({
  audibleRegion: audibleRegionSchema,
});

const AUDIBLE_REGION_LABELS: Record<string, string> = {
  us: 'Audible.com (US)',
  ca: 'Audible.ca (Canada)',
  uk: 'Audible.co.uk (UK)',
  au: 'Audible.com.au (Australia)',
  fr: 'Audible.fr (France)',
  de: 'Audible.de (Germany)',
  jp: 'Audible.co.jp (Japan)',
  it: 'Audible.it (Italy)',
  in: 'Audible.in (India)',
  es: 'Audible.es (Spain)',
};

type MetadataFormData = z.infer<typeof metadataFormSchema>;

export function MetadataSettingsForm() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { isDirty } } = useForm<MetadataFormData>({
    defaultValues: { audibleRegion: DEFAULT_SETTINGS.metadata.audibleRegion },
    resolver: zodResolver(metadataFormSchema),
  });

  useEffect(() => {
    if (settings?.metadata && !isDirty) {
      reset({ audibleRegion: settings.metadata.audibleRegion });
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: MetadataFormData) =>
      api.updateSettings({ metadata: data as AppSettings['metadata'] }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Metadata settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <SettingsSection
      icon={<HeadphonesIcon className="w-5 h-5 text-primary" />}
      title="Metadata"
      description="Configure audiobook metadata providers"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div>
          <label htmlFor="audibleRegion" className="block text-sm font-medium mb-2">Audible Region</label>
          <select
            id="audibleRegion"
            {...register('audibleRegion')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          >
            {audibleRegionSchema.options.map((region) => (
              <option key={region} value={region}>
                {AUDIBLE_REGION_LABELS[region] ?? region}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground mt-2">
            Select your Audible region for metadata lookups. Affects which catalog is searched for audiobook details, narrators, and cover art.
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
