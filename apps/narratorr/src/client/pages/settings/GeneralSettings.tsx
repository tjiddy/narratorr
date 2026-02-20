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
  library: { path: '', folderFormat: '{author}/{title}' },
  search: { enabled: false, intervalMinutes: 360, autoGrab: false },
  import: { deleteAfterImport: false, minSeedTime: 60 },
  general: { logLevel: 'info' as const },
  metadata: { audibleRegion: 'us' as const },
};

function settingsToFormData(settings: NonNullable<ReturnType<typeof api.getSettings> extends Promise<infer T> ? T : never>): UpdateSettingsFormData {
  return {
    library: { path: settings.library.path, folderFormat: settings.library.folderFormat },
    search: {
      enabled: settings.search?.enabled ?? false,
      intervalMinutes: settings.search?.intervalMinutes ?? 360,
      autoGrab: settings.search?.autoGrab ?? false,
    },
    import: {
      deleteAfterImport: settings.import?.deleteAfterImport ?? false,
      minSeedTime: settings.import?.minSeedTime ?? 60,
    },
    general: { logLevel: settings.general?.logLevel || 'info' },
    metadata: { audibleRegion: settings.metadata?.audibleRegion || 'us' },
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
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved successfully');
    },
    onError: () => {
      toast.error('Failed to save settings');
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

      <SettingsSection
        icon={<TerminalIcon className="w-5 h-5 text-primary" />}
        title="Logging"
        description="Control server log verbosity"
      >
        <div>
          <label className="block text-sm font-medium mb-2">Log Level</label>
          <select
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
          <label className="block text-sm font-medium mb-2">Audible Region</label>
          <select
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
