import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { PackageIcon } from '@/components/icons';
import { DEFAULT_SETTINGS, importSettingsSchema, stripDefaults } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const importFormSchema = stripDefaults(importSettingsSchema);

type ImportFormData = z.infer<typeof importFormSchema>;

export function ImportSettingsSection() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<ImportFormData>({
    defaultValues: DEFAULT_SETTINGS.import,
    resolver: zodResolver(importFormSchema),
  });

  useEffect(() => {
    if (settings?.import && !isDirty) {
      reset(settings.import);
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: ImportFormData) =>
      api.updateSettings({ import: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Import settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <SettingsSection
      icon={<PackageIcon className="w-5 h-5 text-primary" />}
      title="Import"
      description="Configure post-download import behavior"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="deleteAfterImport" className="block text-sm font-medium">Delete After Import</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Remove torrent from download client after files are imported
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input id="deleteAfterImport" type="checkbox" {...register('deleteAfterImport')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="redownloadFailed" className="block text-sm font-medium">Redownload Failed</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Automatically search for and attempt to download a different release when a download fails
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input id="redownloadFailed" type="checkbox" {...register('redownloadFailed')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
          </label>
        </div>

        <div>
          <label htmlFor="minSeedTime" className="block text-sm font-medium mb-2">Minimum Seed Time (minutes)</label>
          <input
            id="minSeedTime"
            type="number"
            {...register('minSeedTime', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
              errors.minSeedTime ? 'border-destructive' : 'border-border'
            }`}
            min={0}
            placeholder="60"
          />
          {errors.minSeedTime && (
            <p className="text-sm text-destructive mt-1">{errors.minSeedTime.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            How long to seed before removing the torrent (only applies when delete after import is enabled)
          </p>
        </div>

        <div>
          <label htmlFor="minFreeSpaceGB" className="block text-sm font-medium mb-2">Minimum Free Space (GB)</label>
          <input
            id="minFreeSpaceGB"
            type="number"
            {...register('minFreeSpaceGB', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
              errors.minFreeSpaceGB ? 'border-destructive' : 'border-border'
            }`}
            min={0}
            step={1}
            placeholder="5"
          />
          {errors.minFreeSpaceGB && (
            <p className="text-sm text-destructive mt-1">{errors.minFreeSpaceGB.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Block imports when free disk space is below this threshold. Set to 0 to disable.
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
