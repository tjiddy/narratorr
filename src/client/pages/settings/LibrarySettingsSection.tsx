// Does not use useSettingsForm: uses setQueryData for optimistic cache update
// and resetField for single-field reset, which don't fit the hook's full-form reset model.
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { FolderIcon } from '@/components/icons';
import { PathInput } from '@/components/PathInput';
import { ConfirmModal } from '@/components/ConfirmModal';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { BulkOperationsSection } from '@/components/library/BulkOperationsSection';

const libraryPathSchema = z.object({
  path: z.string().trim().min(1, 'Library path is required'),
});

type LibraryPathFormData = z.infer<typeof libraryPathSchema>;

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
      toast.error(getErrorMessage(err));
    },
  });

  const rescanMutation = useMutation({
    mutationFn: () => api.rescanLibrary(),
    onSuccess: (result) => {
      toast.success(`Library scan complete: ${result.scanned} scanned, ${result.missing} missing, ${result.restored} restored`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
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
      <ConfirmModal
        isOpen={showRescanPrompt}
        title="Refresh Library?"
        message="Would you like to refresh the library at the new path?"
        confirmLabel="Refresh"
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
