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
import { DEFAULT_SETTINGS, qualityFormSchema } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const qualityGateFormSchema = qualityFormSchema.pick({ grabFloor: true, minSeeders: true });

type QualityGateFormData = z.infer<typeof qualityGateFormSchema>;

export function QualitySettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<QualityGateFormData>({
    defaultValues: {
      grabFloor: DEFAULT_SETTINGS.quality.grabFloor,
      minSeeders: DEFAULT_SETTINGS.quality.minSeeders,
    },
    resolver: zodResolver(qualityGateFormSchema),
  });

  useEffect(() => {
    if (settings?.quality && !isDirty) {
      reset({
        grabFloor: settings.quality.grabFloor,
        minSeeders: settings.quality.minSeeders,
      });
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: QualityGateFormData) => api.updateSettings({ quality: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Quality settings saved');
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, 'Failed to save settings'));
    },
  });

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Quality"
      description="Minimum bar to grab"
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
