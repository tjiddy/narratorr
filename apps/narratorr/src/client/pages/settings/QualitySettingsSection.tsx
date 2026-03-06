import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import { ZapIcon } from '@/components/icons';
import { protocolPreferenceSchema, type UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const PROTOCOL_LABELS: Record<string, string> = {
  none: 'No Preference',
  usenet: 'Prefer Usenet',
  torrent: 'Prefer Torrent',
};

interface QualitySettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
}

export function QualitySettingsSection({ register, errors }: QualitySettingsSectionProps) {
  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Quality"
      description="Quality filtering, upgrade monitoring, and protocol preferences"
    >
      <div>
        <label htmlFor="grabFloor" className="block text-sm font-medium mb-2">MB/hr Grab Floor</label>
        <input
          id="grabFloor"
          type="number"
          {...register('quality.grabFloor', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.quality?.grabFloor ? 'border-destructive' : 'border-border'
          }`}
          min={0}
          step="any"
          placeholder="0"
        />
        {errors.quality?.grabFloor && (
          <p className="text-sm text-destructive mt-1">{errors.quality.grabFloor.message}</p>
        )}
        <p className="text-sm text-muted-foreground mt-2">
          Minimum MB/hr to accept. Releases below this threshold are hidden from search results. Set to 0 to disable.
        </p>
      </div>

      <div>
        <label htmlFor="protocolPreference" className="block text-sm font-medium mb-2">Protocol Preference</label>
        <select
          id="protocolPreference"
          {...register('quality.protocolPreference')}
          className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
        >
          {protocolPreferenceSchema.options.map((pref) => (
            <option key={pref} value={pref}>
              {PROTOCOL_LABELS[pref] ?? pref}
            </option>
          ))}
        </select>
        <p className="text-sm text-muted-foreground mt-2">
          Preferred download protocol. Affects result ordering but does not exclude results.
        </p>
      </div>

      <div>
        <label htmlFor="minSeeders" className="block text-sm font-medium mb-2">Minimum Seeders</label>
        <input
          id="minSeeders"
          type="number"
          {...register('quality.minSeeders', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.quality?.minSeeders ? 'border-destructive' : 'border-border'
          }`}
          min={0}
          step={1}
          placeholder="0"
        />
        {errors.quality?.minSeeders && (
          <p className="text-sm text-destructive mt-1">{errors.quality.minSeeders.message}</p>
        )}
        <p className="text-sm text-muted-foreground mt-2">
          Torrent results with fewer seeders are hidden. Does not affect Usenet results. Set to 0 to disable.
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
            <input id="qualitySearchImmediately" type="checkbox" {...register('quality.searchImmediately')} className="sr-only peer" />
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
            <input id="qualityMonitorForUpgrades" type="checkbox" {...register('quality.monitorForUpgrades')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
          </label>
        </div>
      </div>
    </SettingsSection>
  );
}
