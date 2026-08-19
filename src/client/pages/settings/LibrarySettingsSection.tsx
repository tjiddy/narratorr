// Needs per-field reset and optimistic cache updates, unlike useSettingsForm's full-form model.
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { useTrackedForm } from '@/hooks/dirty-forms.js';
import { FolderIcon } from '@/components/icons';
import { PathInput } from '@/components/PathInput';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const libraryPathSchema = z.object({
  path: z.string().trim().min(1, 'Library path is required'),
});

type LibraryPathFormData = z.infer<typeof libraryPathSchema>;

const CARD_LABEL = 'Library';

export function LibrarySettingsSection() {
  const queryClient = useQueryClient();
  const [showRescanPrompt, setShowRescanPrompt] = useState(false);

  const { data: settings, isError, refetch } = useQuery({
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
    // No read, no write. Until settings arrive the field holds the schema default, so a bare
    // focus/blur here would persist `/audiobooks` over the operator's real library path — the
    // old `?? ''` comparison made every unread value look like a deliberate change.
    if (!settings) return;
    const currentPath = ((e.target as HTMLInputElement).value ?? '').trim();
    const savedPath = settings.library.path;
    if (!currentPath || currentPath === savedPath) return;
    pathSaveMutation.mutate(currentPath);
  };

  // eslint-disable-next-line react-hooks/incompatible-library -- watch() is the standard RHF API; Compiler skip is expected
  const pathValue = watch('path');

  // Empty or unchanged blur saves are skipped, so those edits remain guarded.
  useTrackedForm({ isDirty, isPending: pathSaveMutation.isPending, label: CARD_LABEL });

  return (
    <SettingsSection
      icon={<FolderIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Configure where audiobooks are stored"
    >
      {/* Inline shape, matching this surface's existing SettingsSection layout. Deliberately
          NOT gated on loading as well: while the read is pending the row keeps rendering, and
          handlePathBlur's `!settings` guard is the whole of the protection in that window —
          hiding the row would make that guard unreachable from the DOM. */}
      {isError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load library settings.</p>
          <button
            type="button"
            onClick={() => { void refetch(); }}
            aria-label="Retry loading library settings"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : (
        <SettingsTable>
          <SettingsRow
            layout="stacked"
            htmlFor="libraryPath"
            label="Library path"
            description="The root folder where imported audiobooks will be stored"
          >
            <PathInput
              id="libraryPath"
              value={pathValue ?? ''}
              onChange={(path) => setValue('path', path, { shouldDirty: true, shouldValidate: true })}
              registration={{ ...pathRegistration, onBlur: handlePathBlur }}
              error={errors.path}
              placeholder="/audiobooks"
            />
          </SettingsRow>
        </SettingsTable>
      )}
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
