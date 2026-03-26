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
import { renderTemplate, renderFilename, toLastFirst, toSortTitle, ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from '@core/utils/index.js';
import { DEFAULT_SETTINGS, type AppSettings, libraryFormSchema } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type LibraryFormData = AppSettings['library'];

const SAMPLE_AUTHOR = 'Brandon Sanderson';
const SAMPLE_TITLE = 'The Way of Kings';
const SAMPLE_NARRATOR = 'Michael Kramer, Kate Reading';
const SAMPLE_TOKENS = {
  author: SAMPLE_AUTHOR,
  authorLastFirst: toLastFirst(SAMPLE_AUTHOR),
  title: SAMPLE_TITLE,
  titleSort: toSortTitle(SAMPLE_TITLE),
  series: 'The Stormlight Archive',
  seriesPosition: 1,
  year: '2010',
  narrator: SAMPLE_NARRATOR,
  narratorLastFirst: toLastFirst(SAMPLE_NARRATOR),
};

const SAMPLE_TOKENS_NO_SERIES = {
  author: 'Andy Weir',
  authorLastFirst: toLastFirst('Andy Weir'),
  title: 'Project Hail Mary',
  titleSort: toSortTitle('Project Hail Mary'),
  year: '2021',
  narrator: 'Ray Porter',
  narratorLastFirst: toLastFirst('Ray Porter'),
};

/** File-only tokens that don't appear in folder format */
const FILE_ONLY_TOKENS = FILE_ALLOWED_TOKENS.filter(t => !(ALLOWED_TOKENS as readonly string[]).includes(t));

interface TokenPanelProps {
  tokens: readonly string[];
  extraTokens?: readonly string[];
  onInsert: (token: string) => void;
  label: string;
}

function TokenPanel({ tokens, extraTokens, onInsert, label }: TokenPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        {label}
      </button>

      {open && (
        <div className="flex flex-wrap gap-1.5 mt-1.5 animate-fade-in">
          {tokens.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => onInsert(token)}
              className="px-2 py-0.5 bg-muted hover:bg-muted/80 text-xs font-mono rounded-md transition-colors cursor-pointer"
            >
              {`{${token}}`}
            </button>
          ))}
          {extraTokens && extraTokens.length > 0 && (
            <>
              <span className="w-px h-5 bg-border self-center mx-0.5" />
              {extraTokens.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => onInsert(token)}
                  className="px-2 py-0.5 bg-primary/10 hover:bg-primary/20 text-xs font-mono rounded-md transition-colors cursor-pointer text-primary"
                >
                  {`{${token}}`}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line complexity, max-lines-per-function -- folder/file format validation + token insertion + preview for both templates
export function LibrarySettingsSection() {
  const queryClient = useQueryClient();
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);
  const [showRescanPrompt, setShowRescanPrompt] = useState(false);

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
      // Clear path dirty state so Save button only reflects unsaved sibling fields
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

  // Typed as ChangeHandler (async, returns Promise<void>) so it satisfies registration.onBlur type
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

  const previewPath = useMemo(() => {
    if (!folderFormat) return '';
    return renderTemplate(folderFormat, SAMPLE_TOKENS);
  }, [folderFormat]);

  const previewFilename = useMemo(() => {
    if (!fileFormat) return '';
    return renderFilename(fileFormat, {
      ...SAMPLE_TOKENS,
      trackNumber: 1,
      trackTotal: 12,
      partName: 'The Way of Kings',
    });
  }, [fileFormat]);

  const previewPathNoSeries = useMemo(() => {
    if (!folderFormat) return '';
    return renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES);
  }, [folderFormat]);

  const previewFilenameNoSeries = useMemo(() => {
    if (!fileFormat) return '';
    return renderFilename(fileFormat, {
      ...SAMPLE_TOKENS_NO_SERIES,
      trackNumber: 1,
      trackTotal: 8,
      partName: 'Project Hail Mary',
    });
  }, [fileFormat]);

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

  const insertFolderToken = (token: string) => {
    insertTokenAtCursor(folderFormatRef, 'folderFormat', token);
  };

  const insertFileToken = (token: string) => {
    insertTokenAtCursor(fileFormatRef, 'fileFormat', token);
  };

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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <label htmlFor="folderFormat" className="block text-sm font-medium mb-2">Folder Format</label>
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
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
                errors.folderFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author}/{title}"
            />
            {errors.folderFormat && (
              <p className="text-sm text-destructive mt-1">{errors.folderFormat.message}</p>
            )}

            <TokenPanel
              tokens={ALLOWED_TOKENS}
              onInsert={insertFolderToken}
              label="Insert token"
            />

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
            <label htmlFor="fileFormat" className="block text-sm font-medium mb-2">File Format</label>
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
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
                errors.fileFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author} - {title}"
            />
            {errors.fileFormat && (
              <p className="text-sm text-destructive mt-1">{errors.fileFormat.message}</p>
            )}

            <TokenPanel
              tokens={ALLOWED_TOKENS}
              extraTokens={FILE_ONLY_TOKENS}
              onInsert={insertFileToken}
              label="Insert token"
            />

            {!fileTitleToken && (
              <p className="text-sm text-destructive mt-1.5">
                Template must include {'{title}'} or {'{titleSort}'}
              </p>
            )}
          </div>
        </div>

        <p className="text-sm text-muted-foreground -mt-2">
          Use <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{series? - }'}</code> for conditional separators
          and <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{seriesPosition:00}'}</code> for zero-padding.
          File-specific: <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{trackNumber:00}'}</code> for numbering, <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{partName}'}</code> for chapter names.
        </p>

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
