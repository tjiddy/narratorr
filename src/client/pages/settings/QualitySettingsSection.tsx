import type { z } from 'zod';
import { ZapIcon } from '@/components/icons';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, qualityFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const qualityGateFormSchema = qualityFormSchema.pick({ grabFloor: true, minSeeders: true });

type QualityGateFormData = z.infer<typeof qualityGateFormSchema>;

export function QualitySettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<QualityGateFormData>({
    schema: qualityGateFormSchema,
    defaultValues: {
      grabFloor: DEFAULT_SETTINGS.quality.grabFloor,
      minSeeders: DEFAULT_SETTINGS.quality.minSeeders,
    },
    select: (s: AppSettings) => ({
      grabFloor: s.quality.grabFloor,
      minSeeders: s.quality.minSeeders,
    }),
    toPayload: (d) => ({ quality: d }),
    successMessage: 'Quality settings saved',
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Quality"
      description="Minimum bar to grab"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div>
          <label htmlFor="grabFloor" className="block text-sm font-medium mb-2">MB/hr Grab Minimum</label>
          <input
            id="grabFloor"
            type="number"
            {...register('grabFloor', { valueAsNumber: true })}
            className={errorInputClass(!!errors.grabFloor)}
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
            className={errorInputClass(!!errors.minSeeders)}
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
