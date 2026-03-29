import { useRef, useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FolderIcon } from '@/components/icons';
import { PathInput } from '@/components/PathInput';
import { ConfirmModal } from '@/components/ConfirmModal';
import { NamingTokenModal } from '@/components/settings/NamingTokenModal';
import { renderTemplate, renderFilename, toLastFirst, toSortTitle, NAMING_PRESETS, detectPreset } from '@core/utils/index.js';
import { DEFAULT_SETTINGS, type AppSettings, libraryFormSchema, namingSeparatorValues, namingCaseValues } from '../../../shared/schemas.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { SettingsSection } from './SettingsSection';
import { BulkOperationsSection } from '@/components/library/BulkOperationsSection';

type LibraryFormData = AppSettings['library'];

const SAMPLE_TOKENS = {
  author: 'Brandon Sanderson', authorLastFirst: toLastFirst('Brandon Sanderson'),
  title: 'The Way of Kings', titleSort: toSortTitle('The Way of Kings'),
  series: 'The Stormlight Archive', seriesPosition: 1, year: '2010',
  narrator: 'Michael Kramer, Kate Reading', narratorLastFirst: toLastFirst('Michael Kramer, Kate Reading'),
};
const SAMPLE_TOKENS_NO_SERIES = {
  author: 'Andy Weir', authorLastFirst: toLastFirst('Andy Weir'),
  title: 'Project Hail Mary', titleSort: toSortTitle('Project Hail Mary'),
  year: '2021', narrator: 'Ray Porter', narratorLastFirst: toLastFirst('Ray Porter'),
};
const SEPARATOR_LABELS: Record<string, string> = { space: 'Space', period: 'Period', underscore: 'Underscore', dash: 'Dash' };
const CASE_LABELS: Record<string, string> = { default: 'Default', lower: 'lowercase', upper: 'UPPERCASE', title: 'Title Case' };

// eslint-disable-next-line complexity, max-lines-per-function -- folder/file format validation + token insertion + preview for both templates
export function LibrarySettingsSection() {
  const queryClient = useQueryClient();
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);
  const [showRescanPrompt, setShowRescanPrompt] = useState(false);
  const [tokenModalScope, setTokenModalScope] = useState<'folder' | 'file' | null>(null);

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, resetField, watch, setValue, formState: { errors, isDirty } } = useForm<LibraryFormData>({
    defaultValues: DEFAULT_SETTINGS.library,
    resolver: zodResolver(libraryFormSchema),
  });

  useEffect(() => {
    if (settings?.library && !isDirty) {
      reset(settings.library);
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: LibraryFormData) => api.updateSettings({ library: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Library settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

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
  const folderFormat = watch('folderFormat');
  const fileFormat = watch('fileFormat');
  const namingSeparator = watch('namingSeparator');
  const namingCase = watch('namingCase');

  const namingOptions: NamingOptions = useMemo(() => ({
    separator: namingSeparator ?? 'space', case: namingCase ?? 'default',
  }), [namingSeparator, namingCase]);
  const currentPreset = useMemo(() => detectPreset(folderFormat ?? '', fileFormat ?? ''), [folderFormat, fileFormat]);

  const { previewPath, previewFilename } = useMemo(() => ({
    previewPath: folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS, namingOptions) : '',
    previewFilename: fileFormat ? renderFilename(fileFormat, { ...SAMPLE_TOKENS, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings' }, namingOptions) : '',
  }), [folderFormat, fileFormat, namingOptions]);

  const { previewPathNoSeries, previewFilenameNoSeries } = useMemo(() => ({
    previewPathNoSeries: folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '',
    previewFilenameNoSeries: fileFormat ? renderFilename(fileFormat, { ...SAMPLE_TOKENS_NO_SERIES, trackNumber: 1, trackTotal: 8, partName: 'Project Hail Mary' }, namingOptions) : '',
  }), [folderFormat, fileFormat, namingOptions]);

  const hasTitleToken = folderFormat ? /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const hasAuthorToken = folderFormat ? /\{author(?:LastFirst)?(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const fileTitleToken = fileFormat ? /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(fileFormat) : true;
  const insertTokenAtCursor = (
    ref: React.RefObject<HTMLInputElement | null>,
    field: 'folderFormat' | 'fileFormat',
    token: string,
  ) => {
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const newValue = `${before}{${token}}${after}`;
    setValue(field, newValue, { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => {
      const pos = start + token.length + 2;
      input.setSelectionRange(pos, pos);
      input.focus();
    });
  };
  const handlePresetChange = (presetId: string) => {
    const preset = NAMING_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setValue('folderFormat', preset.folderFormat, { shouldDirty: true, shouldValidate: true });
    setValue('fileFormat', preset.fileFormat, { shouldDirty: true, shouldValidate: true });
  };
  const handleTokenModalInsert = (token: string) => {
    if (tokenModalScope === 'folder') {
      insertTokenAtCursor(folderFormatRef, 'folderFormat', token);
    } else if (tokenModalScope === 'file') {
      insertTokenAtCursor(fileFormatRef, 'fileFormat', token);
    }
  };

  const modalPreviewTokens = useMemo(() => {
    if (tokenModalScope === 'file') {
      return { ...SAMPLE_TOKENS, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings' };
    }
    return SAMPLE_TOKENS;
  }, [tokenModalScope]);

  return (
    <SettingsSection
      icon={<FolderIcon className="w-5 h-5 text-primary" />}
      title="Library"
      description="Configure where audiobooks are stored"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div>
          <label htmlFor="libraryPath" className="block text-sm font-medium mb-2">Library Path</label>
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

        {/* Preset + Separator + Case row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="namingPreset" className="block text-xs font-medium text-muted-foreground mb-1">Preset</label>
            <select
              id="namingPreset"
              value={currentPreset}
              onChange={(e) => handlePresetChange(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus-ring"
            >
              {NAMING_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              {currentPreset === 'custom' && <option value="custom">Custom</option>}
            </select>
          </div>
          <div>
            <label htmlFor="namingSeparator" className="block text-xs font-medium text-muted-foreground mb-1">Separator</label>
            <select
              id="namingSeparator"
              {...register('namingSeparator')}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus-ring"
            >
              {namingSeparatorValues.map((v) => (
                <option key={v} value={v}>{SEPARATOR_LABELS[v]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="namingCase" className="block text-xs font-medium text-muted-foreground mb-1">Case</label>
            <select
              id="namingCase"
              {...register('namingCase')}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus-ring"
            >
              {namingCaseValues.map((v) => (
                <option key={v} value={v}>{CASE_LABELS[v]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label htmlFor="folderFormat" className="text-sm font-medium">Folder Format</label>
              <button
                type="button"
                onClick={() => setTokenModalScope('folder')}
                className="w-5 h-5 rounded-full bg-muted hover:bg-muted/80 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
                aria-label="Folder token reference"
              >
                ?
              </button>
            </div>
            <input
              id="folderFormat"
              type="text"
              {...(() => {
                const { ref: rhfRef, ...rest } = register('folderFormat');
                return {
                  ...rest,
                  ref: (el: HTMLInputElement | null) => {
                    rhfRef(el);
                    folderFormatRef.current = el;
                  },
                };
              })()}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all font-mono text-sm ${
                errors.folderFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author}/{title}"
            />
            {errors.folderFormat && (
              <p className="text-sm text-destructive mt-1">{errors.folderFormat.message}</p>
            )}

            {!hasTitleToken && (
              <p className="text-sm text-destructive mt-1.5">
                Template must include {'{title}'} or {'{titleSort}'}
              </p>
            )}
            {hasTitleToken && !hasAuthorToken && (
              <p className="text-sm text-amber-500 mt-1.5">
                Consider including {'{author}'} for better organization
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <label htmlFor="fileFormat" className="text-sm font-medium">File Format</label>
              <button
                type="button"
                onClick={() => setTokenModalScope('file')}
                className="w-5 h-5 rounded-full bg-muted hover:bg-muted/80 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
                aria-label="File token reference"
              >
                ?
              </button>
            </div>
            <input
              id="fileFormat"
              type="text"
              {...(() => {
                const { ref: rhfRef, ...rest } = register('fileFormat');
                return {
                  ...rest,
                  ref: (el: HTMLInputElement | null) => {
                    rhfRef(el);
                    fileFormatRef.current = el;
                  },
                };
              })()}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all font-mono text-sm ${
                errors.fileFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author} - {title}"
            />
            {errors.fileFormat && (
              <p className="text-sm text-destructive mt-1">{errors.fileFormat.message}</p>
            )}

            {!fileTitleToken && (
              <p className="text-sm text-destructive mt-1.5">
                Template must include {'{title}'} or {'{titleSort}'}
              </p>
            )}
          </div>
        </div>

        {(folderFormat || fileFormat) && (
          <div className="p-3 bg-muted/50 rounded-lg border border-border space-y-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">With series</p>
              <p className="text-sm font-mono break-all">
                {previewPath ? (
                  <>
                    <span className="text-muted-foreground">{previewPath}/</span>
                    <span>{previewFilename ? `${previewFilename}.m4b` : ''}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground italic">Empty path</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Without series</p>
              <p className="text-sm font-mono break-all">
                {previewPathNoSeries ? (
                  <>
                    <span className="text-muted-foreground">{previewPathNoSeries}/</span>
                    <span>{previewFilenameNoSeries ? `${previewFilenameNoSeries}.m4b` : ''}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground italic">Empty path</span>
                )}
              </p>
            </div>
          </div>
        )}

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
      <div className="mt-4 pt-4 border-t border-border/30">
        <Link
          to="/library-import"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
        >
          <FolderIcon className="w-4 h-4" />
          Scan Library
        </Link>
        <p className="text-xs text-muted-foreground mt-2">
          Scan the library folder to register existing audiobooks
        </p>
      </div>
      <BulkOperationsSection />
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
      <NamingTokenModal
        isOpen={tokenModalScope !== null}
        onClose={() => setTokenModalScope(null)}
        onInsert={handleTokenModalInsert}
        scope={tokenModalScope ?? 'folder'}
        currentFormat={tokenModalScope === 'file' ? (fileFormat ?? '') : (folderFormat ?? '')}
        previewTokens={modalPreviewTokens}
        namingOptions={namingOptions}
      />
    </SettingsSection>
  );
}
