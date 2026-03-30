import { useRef, useMemo, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { TagIcon, ChevronDownIcon } from '@/components/icons';
import { NamingTokenModal } from '@/components/settings/NamingTokenModal';
import { renderTemplate, renderFilename, toLastFirst, toSortTitle, NAMING_PRESETS, detectPreset } from '@core/utils/index.js';
import { DEFAULT_SETTINGS, type AppSettings, namingSeparatorValues, namingCaseValues } from '../../../shared/schemas.js';
import type { NamingSeparator, NamingCase } from '../../../shared/schemas/settings/library.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { SettingsSection } from './SettingsSection';
import { z } from 'zod';
import { FOLDER_ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from '@core/utils/index.js';

type NamingFormData = Pick<AppSettings['library'], 'folderFormat' | 'fileFormat' | 'namingSeparator' | 'namingCase'>;

function hasTitle(val: string): boolean {
  return /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val);
}

function validateTokens(val: string, allowed: readonly string[]): boolean {
  const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(val)) !== null) {
    if (!allowed.includes(match[1])) return false;
  }
  return true;
}

const namingFormSchema = z.object({
  folderFormat: z.string().trim().min(1, 'Folder format is required').refine(
    hasTitle,
    { message: 'Template must include {title} or {titleSort}' },
  ).refine(
    (val) => validateTokens(val, FOLDER_ALLOWED_TOKENS),
    { message: 'Unknown token in template' },
  ),
  fileFormat: z.string().trim().min(1, 'File format is required').refine(
    hasTitle,
    { message: 'Template must include {title} or {titleSort}' },
  ).refine(
    (val) => validateTokens(val, FILE_ALLOWED_TOKENS),
    { message: 'Unknown token in file template' },
  ),
  namingSeparator: z.enum(namingSeparatorValues),
  namingCase: z.enum(namingCaseValues),
});

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

const SEPARATOR_LABELS: Record<NamingSeparator, string> = { space: 'Space', period: 'Period', underscore: 'Underscore', dash: 'Dash' };
const CASE_LABELS: Record<NamingCase, string> = { default: 'Default', lower: 'lowercase', upper: 'UPPERCASE', title: 'Title Case' };

export function NamingSettingsSection() {
  const queryClient = useQueryClient();
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);
  const [tokenModalScope, setTokenModalScope] = useState<'folder' | 'file' | null>(null);

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isDirty } } = useForm<NamingFormData>({
    defaultValues: {
      folderFormat: DEFAULT_SETTINGS.library.folderFormat,
      fileFormat: DEFAULT_SETTINGS.library.fileFormat,
      namingSeparator: DEFAULT_SETTINGS.library.namingSeparator,
      namingCase: DEFAULT_SETTINGS.library.namingCase,
    },
    resolver: zodResolver(namingFormSchema),
  });

  useEffect(() => {
    if (settings?.library && !isDirty) {
      reset({
        folderFormat: settings.library.folderFormat,
        fileFormat: settings.library.fileFormat,
        namingSeparator: settings.library.namingSeparator,
        namingCase: settings.library.namingCase,
      });
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: NamingFormData) => api.updateSettings({ library: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('File naming settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- watch() is the standard RHF API; Compiler skip is expected
  const folderFormat = watch('folderFormat');
  const fileFormat = watch('fileFormat');
  const namingSeparator = watch('namingSeparator');
  const namingCase = watch('namingCase');

  const namingOptions: NamingOptions = useMemo(() => ({
    separator: namingSeparator ?? 'space', case: namingCase ?? 'default',
  }), [namingSeparator, namingCase]);
  const currentPreset = useMemo(() => detectPreset(folderFormat ?? '', fileFormat ?? ''), [folderFormat, fileFormat]);

  const folderPreview = useMemo(() =>
    folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS, namingOptions) : '',
  [folderFormat, namingOptions]);
  const folderPreviewNoSeries = useMemo(() =>
    folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '',
  [folderFormat, namingOptions]);
  const filePreview = useMemo(() =>
    fileFormat ? renderFilename(fileFormat, { ...SAMPLE_TOKENS, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings' }, namingOptions) : '',
  [fileFormat, namingOptions]);
  const filePreviewNoSeries = useMemo(() =>
    fileFormat ? renderFilename(fileFormat, { ...SAMPLE_TOKENS_NO_SERIES, trackNumber: 1, trackTotal: 8, partName: 'Project Hail Mary' }, namingOptions) : '',
  [fileFormat, namingOptions]);

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
      icon={<TagIcon className="w-5 h-5 text-primary" />}
      title="File Naming"
      description="Configure how audiobook files and folders are named"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        {/* Preset + Separator + Case row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="namingPreset" className="block text-xs font-medium text-muted-foreground mb-1">Preset</label>
            <div className="relative">
              <select
                id="namingPreset"
                value={currentPreset}
                onChange={(e) => handlePresetChange(e.target.value)}
                className="w-full appearance-none px-4 py-3 pr-10 bg-background border border-border rounded-xl text-sm focus-ring cursor-pointer"
              >
                {NAMING_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                {currentPreset === 'custom' && <option value="custom">Custom</option>}
              </select>
              <ChevronDownIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>
          </div>
          <div>
            <label htmlFor="namingSeparator" className="block text-xs font-medium text-muted-foreground mb-1">Separator</label>
            <div className="relative">
              <select
                id="namingSeparator"
                {...register('namingSeparator')}
                className="w-full appearance-none px-4 py-3 pr-10 bg-background border border-border rounded-xl text-sm focus-ring cursor-pointer"
              >
                {namingSeparatorValues.map((v) => (
                  <option key={v} value={v}>{SEPARATOR_LABELS[v]}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>
          </div>
          <div>
            <label htmlFor="namingCase" className="block text-xs font-medium text-muted-foreground mb-1">Case</label>
            <div className="relative">
              <select
                id="namingCase"
                {...register('namingCase')}
                className="w-full appearance-none px-4 py-3 pr-10 bg-background border border-border rounded-xl text-sm focus-ring cursor-pointer"
              >
                {namingCaseValues.map((v) => (
                  <option key={v} value={v}>{CASE_LABELS[v]}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>
          </div>
        </div>

        {/* Folder Format — full width with per-field preview */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <label htmlFor="folderFormat" className="text-sm font-medium">Folder Format</label>
            <button
              type="button"
              onClick={() => setTokenModalScope('folder')}
              className="w-5 h-5 rounded-full bg-muted hover:bg-muted/80 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
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
          {folderFormat && (
            <div className="mt-2 p-3 bg-muted/50 rounded-lg border border-border space-y-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">With series</p>
                <p className="text-sm font-mono break-all">
                  {folderPreview ? <span className="text-muted-foreground">{folderPreview}</span> : <span className="text-muted-foreground italic">Empty path</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Without series</p>
                <p className="text-sm font-mono break-all">
                  {folderPreviewNoSeries ? <span className="text-muted-foreground">{folderPreviewNoSeries}</span> : <span className="text-muted-foreground italic">Empty path</span>}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* File Format — full width with per-field preview */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <label htmlFor="fileFormat" className="text-sm font-medium">File Format</label>
            <button
              type="button"
              onClick={() => setTokenModalScope('file')}
              className="w-5 h-5 rounded-full bg-muted hover:bg-muted/80 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
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
          {fileFormat && (
            <div className="mt-2 p-3 bg-muted/50 rounded-lg border border-border space-y-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">With series</p>
                <p className="text-sm font-mono break-all">
                  {filePreview ? <span>{filePreview}.m4b</span> : <span className="text-muted-foreground italic">Empty</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Without series</p>
                <p className="text-sm font-mono break-all">
                  {filePreviewNoSeries ? <span>{filePreviewNoSeries}.m4b</span> : <span className="text-muted-foreground italic">Empty</span>}
                </p>
              </div>
            </div>
          )}
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
