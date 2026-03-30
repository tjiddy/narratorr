import { useRef, useMemo, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type FieldError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { TagIcon } from '@/components/icons';
import { NamingTokenModal } from '@/components/settings/NamingTokenModal';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { renderTemplate, renderFilename, toLastFirst, toSortTitle, NAMING_PRESETS, detectPreset } from '@core/utils/index.js';
import { DEFAULT_SETTINGS, namingSeparatorValues, namingCaseValues, namingFormSchema, hasTitle, hasAuthor, FOLDER_TITLE_MSG, AUTHOR_ADVISORY_MSG } from '../../../shared/schemas.js';
import type { NamingSeparator, NamingCase } from '../../../shared/schemas/settings/library.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { SettingsSection } from './SettingsSection';
import type { z } from 'zod';

type NamingFormData = z.infer<typeof namingFormSchema>;

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


interface FormatFieldProps {
  id: string;
  label: string;
  ariaLabel: string;
  placeholder: string;
  error?: FieldError;
  preview: string;
  previewNoSeries: string;
  previewSuffix?: string;
  warnings?: ReactNode;
  onOpenTokenModal: () => void;
  registerProps: Record<string, unknown>;
  inputRef: (el: HTMLInputElement | null) => void;
  hasValue: boolean;
}

function FormatField({ id, label, ariaLabel, placeholder, error, preview, previewNoSeries, previewSuffix, warnings, onOpenTokenModal, registerProps, inputRef, hasValue }: FormatFieldProps) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <label htmlFor={id} className="text-sm font-medium">{label}</label>
        <button
          type="button"
          onClick={onOpenTokenModal}
          className="w-5 h-5 rounded-full bg-muted hover:bg-muted/80 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
          aria-label={ariaLabel}
        >
          ?
        </button>
      </div>
      <input
        id={id}
        type="text"
        {...registerProps}
        ref={inputRef}
        className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all font-mono text-sm ${
          error ? 'border-destructive' : 'border-border'
        }`}
        placeholder={placeholder}
      />
      {error && <p className="text-sm text-destructive mt-1">{error.message}</p>}
      {warnings}
      {hasValue && (
        <div className="mt-2 p-3 bg-muted/50 rounded-lg border border-border space-y-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">With series</p>
            <p className="text-sm font-mono break-all">
              {preview ? <span className="text-muted-foreground">{preview}{previewSuffix}</span> : <span className="text-muted-foreground italic">Empty</span>}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Without series</p>
            <p className="text-sm font-mono break-all">
              {previewNoSeries ? <span className="text-muted-foreground">{previewNoSeries}{previewSuffix}</span> : <span className="text-muted-foreground italic">Empty</span>}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function NamingSettingsSection() {
  const queryClient = useQueryClient();
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);
  const [tokenModalScope, setTokenModalScope] = useState<'folder' | 'file' | null>(null);

  const { data: settings } = useQuery({ queryKey: queryKeys.settings(), queryFn: api.getSettings });

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
        folderFormat: settings.library.folderFormat, fileFormat: settings.library.fileFormat,
        namingSeparator: settings.library.namingSeparator, namingCase: settings.library.namingCase,
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
    onError: (err) => { toast.error(err instanceof Error ? err.message : 'Failed to save settings'); },
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- watch() is the standard RHF API
  const folderFormat = watch('folderFormat');
  const fileFormat = watch('fileFormat');
  const namingSeparator = watch('namingSeparator');
  const namingCase = watch('namingCase');

  const namingOptions: NamingOptions = useMemo(() => ({
    separator: namingSeparator ?? 'space', case: namingCase ?? 'default',
  }), [namingSeparator, namingCase]);
  const currentPreset = useMemo(() => detectPreset(folderFormat ?? '', fileFormat ?? ''), [folderFormat, fileFormat]);

  const folderPreview = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS, namingOptions) : '', [folderFormat, namingOptions]);
  const folderPreviewNoSeries = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '', [folderFormat, namingOptions]);
  const filePreview = useMemo(() => fileFormat ? renderFilename(fileFormat, { ...SAMPLE_TOKENS, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings' }, namingOptions) : '', [fileFormat, namingOptions]);
  const filePreviewNoSeries = useMemo(() => fileFormat ? renderFilename(fileFormat, { ...SAMPLE_TOKENS_NO_SERIES, trackNumber: 1, trackTotal: 8, partName: 'Project Hail Mary' }, namingOptions) : '', [fileFormat, namingOptions]);

  const hasTitleToken = folderFormat ? hasTitle(folderFormat) : true;
  const hasAuthorToken = folderFormat ? hasAuthor(folderFormat) : true;
  const fileTitleToken = fileFormat ? hasTitle(fileFormat) : true;

  const insertTokenAtCursor = (ref: React.RefObject<HTMLInputElement | null>, field: 'folderFormat' | 'fileFormat', token: string) => {
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const newValue = `${input.value.slice(0, start)}{${token}}${input.value.slice(end)}`;
    setValue(field, newValue, { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => { input.setSelectionRange(start + token.length + 2, start + token.length + 2); input.focus(); });
  };
  const handlePresetChange = (presetId: string) => {
    const preset = NAMING_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setValue('folderFormat', preset.folderFormat, { shouldDirty: true, shouldValidate: true });
    setValue('fileFormat', preset.fileFormat, { shouldDirty: true, shouldValidate: true });
  };
  const handleTokenModalInsert = (token: string) => {
    if (tokenModalScope === 'folder') insertTokenAtCursor(folderFormatRef, 'folderFormat', token);
    else if (tokenModalScope === 'file') insertTokenAtCursor(fileFormatRef, 'fileFormat', token);
  };

  const modalPreviewTokens = useMemo(() =>
    tokenModalScope === 'file' ? { ...SAMPLE_TOKENS, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings' } : SAMPLE_TOKENS,
  [tokenModalScope]);

  const folderReg = register('folderFormat');
  const fileReg = register('fileFormat');

  return (
    <SettingsSection icon={<TagIcon className="w-5 h-5 text-primary" />} title="File Naming" description="Configure how audiobook files and folders are named">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SelectWithChevron id="namingPreset" label="Preset" value={currentPreset} onChange={(e) => handlePresetChange(e.currentTarget.value)}>
            {NAMING_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {currentPreset === 'custom' && <option value="custom">Custom</option>}
          </SelectWithChevron>
          <SelectWithChevron id="namingSeparator" label="Separator" {...register('namingSeparator')}>
            {namingSeparatorValues.map((v) => <option key={v} value={v}>{SEPARATOR_LABELS[v]}</option>)}
          </SelectWithChevron>
          <SelectWithChevron id="namingCase" label="Case" {...register('namingCase')}>
            {namingCaseValues.map((v) => <option key={v} value={v}>{CASE_LABELS[v]}</option>)}
          </SelectWithChevron>
        </div>

        <FormatField
          id="folderFormat" label="Folder Format" ariaLabel="Folder token reference" placeholder="{author}/{title}"
          error={errors.folderFormat} preview={folderPreview} previewNoSeries={folderPreviewNoSeries} hasValue={!!folderFormat}
          onOpenTokenModal={() => setTokenModalScope('folder')}
          registerProps={{ ...folderReg, ref: undefined }}
          inputRef={(el) => { folderReg.ref(el); folderFormatRef.current = el; }}
          warnings={<>
            {!hasTitleToken && <p className="text-sm text-destructive mt-1.5">{FOLDER_TITLE_MSG}</p>}
            {hasTitleToken && !hasAuthorToken && <p className="text-sm text-amber-500 mt-1.5">{AUTHOR_ADVISORY_MSG}</p>}
          </>}
        />

        <FormatField
          id="fileFormat" label="File Format" ariaLabel="File token reference" placeholder="{author} - {title}"
          error={errors.fileFormat} preview={filePreview} previewNoSeries={filePreviewNoSeries} previewSuffix=".m4b" hasValue={!!fileFormat}
          onOpenTokenModal={() => setTokenModalScope('file')}
          registerProps={{ ...fileReg, ref: undefined }}
          inputRef={(el) => { fileReg.ref(el); fileFormatRef.current = el; }}
          warnings={!fileTitleToken ? <p className="text-sm text-destructive mt-1.5">{FOLDER_TITLE_MSG}</p> : null}
        />

        {isDirty && (
          <button type="submit" disabled={mutation.isPending} className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in">
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </form>
      <NamingTokenModal
        isOpen={tokenModalScope !== null} onClose={() => setTokenModalScope(null)} onInsert={handleTokenModalInsert}
        scope={tokenModalScope ?? 'folder'} currentFormat={tokenModalScope === 'file' ? (fileFormat ?? '') : (folderFormat ?? '')}
        previewTokens={modalPreviewTokens} namingOptions={namingOptions}
      />
    </SettingsSection>
  );
}
