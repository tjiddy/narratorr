import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FolderIcon } from '@/components/icons';
import { PathInput } from '@/components/PathInput';
import { ConfirmModal } from '@/components/ConfirmModal';
import { DEFAULT_SETTINGS, newBookDefaultsFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { BulkOperationsSection } from '@/components/library/BulkOperationsSection';

const libraryPathSchema = z.object({
  path: z.string().trim().min(1, 'Library path is required'),
});

type LibraryPathFormData = z.infer<typeof libraryPathSchema>;
type NewBookDefaultsFormData = z.infer<typeof newBookDefaultsFormSchema>;

export function LibrarySettingsSection() {
  const queryClient = useQueryClient();
  const [showRescanPrompt, setShowRescanPrompt] = useState(false);

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, reset, resetField, watch, setValue, formState: { errors, isDirty } } = useForm<LibraryPathFormData>({
    defaultValues: { path: DEFAULT_SETTINGS.library.path },
    resolver: zodResolver(libraryPathSchema),
  });

  useEffect(() => {
    if (settings?.library && !isDirty) {
      reset({ path: settings.library.path });
    }
  }, [settings, reset, isDirty]);

  const pathSaveMutation = useMutation({
    mutationFn: (path: string) => api.updateSettings({ library: { path } }),
    onSuccess: (_result, savedPath) => {
      queryClient.setQueryData(queryKeys.settings(), (old: AppSettings | undefined) =>
        old ? { ...old, library: { ...old.library, path: savedPath } } : old,
      );
      resetField('path', { defaultValue: savedPath });
      setShowRescanPrompt(true);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save library path');
    },
  });

  const rescanMutation = useMutation({
    mutationFn: () => api.rescanLibrary(),
    onSuccess: (result) => {
      toast.success(`Library scan complete: ${result.scanned} scanned, ${result.missing} missing, ${result.restored} restored`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Library scan failed');
    },
  });

  const { onBlur: rhfPathOnBlur, ...pathRegistration } = register('path');
  const handlePathBlur: typeof rhfPathOnBlur = async (e) => {
    await rhfPathOnBlur(e);
    const currentPath = ((e.target as HTMLInputElement).value ?? '').trim();
    const savedPath = settings?.library.path ?? '';
    if (!currentPath || currentPath === savedPath) return;
    pathSaveMutation.mutate(currentPath);
  };

  // eslint-disable-next-line react-hooks/incompatible-library -- watch() is the standard RHF API; Compiler skip is expected
  const pathValue = watch('path');

  // New-book defaults form — independent from path blur-save
  const { register: registerDefaults, handleSubmit: handleDefaultsSubmit, reset: resetDefaults, formState: { isDirty: isDefaultsDirty } } = useForm<NewBookDefaultsFormData>({
    defaultValues: { searchImmediately: DEFAULT_SETTINGS.quality.searchImmediately, monitorForUpgrades: DEFAULT_SETTINGS.quality.monitorForUpgrades },
    resolver: zodResolver(newBookDefaultsFormSchema),
  });

  useEffect(() => {
    if (settings?.quality) {
      resetDefaults({
        searchImmediately: settings.quality.searchImmediately,
        monitorForUpgrades: settings.quality.monitorForUpgrades,
      });
    }
  }, [settings, resetDefaults]);

  const defaultsMutation = useMutation({
    mutationFn: (data: NewBookDefaultsFormData) => api.updateSettings({ quality: data }),
    onSuccess: (_result, submittedData) => {
      resetDefaults(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('New book defaults saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <SettingsSection
      icon={<FolderIcon className="w-5 h-5 text-primary" />}
      title="Library"
      description="Configure where audiobooks are stored"
    >
      <div>
        <label htmlFor="libraryPath" className="text-sm font-medium mb-2 block">Library Path</label>
        <PathInput
          id="libraryPath"
          value={pathValue ?? ''}
          onChange={(path) => setValue('path', path, { shouldDirty: true, shouldValidate: true })}
          registration={{ ...pathRegistration, onBlur: handlePathBlur }}
          error={errors.path}
          placeholder="/audiobooks"
        />
        <p className="text-sm text-muted-foreground mt-2">
          The root folder where imported audiobooks will be stored
        </p>
      </div>
      <BulkOperationsSection />
      <div className="border-t border-border pt-6 mt-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">When a New Book Is Added</h4>
        <form onSubmit={handleDefaultsSubmit((data) => defaultsMutation.mutate(data))} className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="librarySearchImmediately" className="block text-sm font-medium">Search Immediately</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Trigger a search as soon as a book is added
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input id="librarySearchImmediately" type="checkbox" {...registerDefaults('searchImmediately')} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="libraryMonitorForUpgrades" className="block text-sm font-medium">Monitor for Upgrades</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Include new books in scheduled upgrade searches
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input id="libraryMonitorForUpgrades" type="checkbox" {...registerDefaults('monitorForUpgrades')} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          {isDefaultsDirty && (
            <button
              type="submit"
              disabled={defaultsMutation.isPending}
              className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in"
            >
              {defaultsMutation.isPending ? 'Saving...' : 'Save'}
            </button>
          )}
        </form>
      </div>
      <ConfirmModal
        isOpen={showRescanPrompt}
        title="Scan Library?"
        message="Would you like to scan the library at the new path?"
        confirmLabel="Scan"
        cancelLabel="Skip"
        onConfirm={() => {
          setShowRescanPrompt(false);
          rescanMutation.mutate();
        }}
        onCancel={() => setShowRescanPrompt(false)}
      />
    </SettingsSection>
  );
}
