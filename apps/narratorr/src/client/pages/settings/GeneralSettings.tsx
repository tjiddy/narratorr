import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import {
  LoadingSpinner,
  CheckIcon,
  TerminalIcon,
  HeadphonesIcon,
} from '@/components/icons';
import {
  updateSettingsFormSchema,
  logLevelSchema,
  audibleRegionSchema,
  type UpdateSettingsFormData,
} from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { LibrarySettingsSection } from './LibrarySettingsSection';
import { SearchSettingsSection } from './SearchSettingsSection';
import { ImportSettingsSection } from './ImportSettingsSection';
import { ProcessingSettingsSection } from './ProcessingSettingsSection';
import { QualitySettingsSection } from './QualitySettingsSection';

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

const defaultValues: UpdateSettingsFormData = {
  library: { path: '', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
  search: { enabled: false, intervalMinutes: 360 },
  import: { deleteAfterImport: false, minSeedTime: 60 },
  general: { logLevel: 'info' as const },
  metadata: { audibleRegion: 'us' as const },
  processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b' as const, keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only' as const },
  tagging: { enabled: false, mode: 'populate_missing' as const, embedCover: false },
  quality: { grabFloor: 0, protocolPreference: 'none' as const, minSeeders: 0, searchImmediately: false, monitorForUpgrades: false },
};

// eslint-disable-next-line complexity -- flat null-coalescing map, no branching logic
function settingsToFormData(settings: NonNullable<ReturnType<typeof api.getSettings> extends Promise<infer T> ? T : never>): UpdateSettingsFormData {
  return {
    library: { path: settings.library.path, folderFormat: settings.library.folderFormat, fileFormat: settings.library.fileFormat ?? '{author} - {title}' },
    search: {
      enabled: settings.search?.enabled ?? false,
      intervalMinutes: settings.search?.intervalMinutes ?? 360,
    },
    import: {
      deleteAfterImport: settings.import?.deleteAfterImport ?? false,
      minSeedTime: settings.import?.minSeedTime ?? 60,
    },
    general: { logLevel: settings.general?.logLevel || 'info' },
    metadata: { audibleRegion: settings.metadata?.audibleRegion || 'us' },
    processing: {
      enabled: settings.processing?.enabled ?? false,
      ffmpegPath: settings.processing?.ffmpegPath ?? '',
      outputFormat: settings.processing?.outputFormat ?? 'm4b',
      keepOriginalBitrate: settings.processing?.keepOriginalBitrate ?? false,
      bitrate: settings.processing?.bitrate ?? 128,
      mergeBehavior: settings.processing?.mergeBehavior ?? 'multi-file-only',
    },
    tagging: {
      enabled: settings.tagging?.enabled ?? false,
      mode: settings.tagging?.mode ?? 'populate_missing',
      embedCover: settings.tagging?.embedCover ?? false,
    },
    quality: {
      grabFloor: settings.quality?.grabFloor ?? 0,
      protocolPreference: settings.quality?.protocolPreference ?? 'none',
      minSeeders: settings.quality?.minSeeders ?? 0,
      searchImmediately: settings.quality?.searchImmediately ?? false,
      monitorForUpgrades: settings.quality?.monitorForUpgrades ?? false,
    },
  };
}

export function GeneralSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const {
    register, handleSubmit, reset, watch, setValue,
    formState: { errors, isDirty },
  } = useForm<UpdateSettingsFormData>({
    resolver: zodResolver(updateSettingsFormSchema),
    defaultValues,
  });

  useEffect(() => {
    if (settings) reset(settingsToFormData(settings));
  }, [settings, reset]);

  const mutation = useMutation({
    mutationFn: async (data: UpdateSettingsFormData) => {
      // Probe ffmpeg before saving when processing is enabled
      if (data.processing.enabled && data.processing.ffmpegPath.trim()) {
        await api.probeFfmpeg(data.processing.ffmpegPath);
      }
      return api.updateSettings(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved successfully');
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      toast.error(message);
    },
  });

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-8">
      <LibrarySettingsSection register={register} errors={errors} setValue={setValue} watch={watch} />
      <SearchSettingsSection register={register} errors={errors} />
      <ImportSettingsSection register={register} errors={errors} />
      <QualitySettingsSection register={register} errors={errors} />
      <ProcessingSettingsSection register={register} errors={errors} watch={watch} />

      <SettingsSection
        icon={<TerminalIcon className="w-5 h-5 text-primary" />}
        title="Logging"
        description="Control server log verbosity"
      >
        <div>
          <label htmlFor="logLevel" className="block text-sm font-medium mb-2">Log Level</label>
          <select
            id="logLevel"
            {...register('general.logLevel')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          >
            {logLevelSchema.options.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground mt-2">
            Set to Debug for detailed diagnostic output, or Error to reduce noise
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<HeadphonesIcon className="w-5 h-5 text-primary" />}
        title="Metadata"
        description="Configure audiobook metadata providers"
      >
        <div>
          <label htmlFor="audibleRegion" className="block text-sm font-medium mb-2">Audible Region</label>
          <select
            id="audibleRegion"
            {...register('metadata.audibleRegion')}
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
      </SettingsSection>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={mutation.isPending || !isDirty}
          className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {mutation.isPending ? (
            <>
              <LoadingSpinner className="w-4 h-4" />
              Saving...
            </>
          ) : (
            <>
              <CheckIcon className="w-4 h-4" />
              Save Changes
            </>
          )}
        </button>
      </div>
    </form>
  );
}
