import { useRef, useMemo, useState } from 'react';
import { TagIcon } from '@/components/icons';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { NamingTokenModal } from '@/components/settings/NamingTokenModal';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { FormatField, FormatFieldHeader } from './NamingFormatField';
import { renderTemplate, renderFilename, toLastFirst, toSortTitle, NAMING_PRESETS, detectPreset, FOLDER_TOKEN_GROUPS, FILE_ONLY_TOKEN_GROUP, TOKEN_PATTERN_SOURCE, templateHasToken, composeEditionSuffixLeaf, sanitizeEditionDiscriminator } from '@core/utils/index.js';
import { DEFAULT_SETTINGS, namingSeparatorValues, namingCaseValues, namingFormSchema, hasTitle, hasAuthor, FOLDER_TITLE_MSG, AUTHOR_ADVISORY_MSG, type AppSettings } from '../../../shared/schemas.js';
import type { NamingSeparator, NamingCase } from '../../../shared/schemas/settings/library.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { SettingsSection } from './SettingsSection';
import type { z } from 'zod';

type NamingFormData = z.infer<typeof namingFormSchema>;

// Fixed edition label used only for the "Multiple editions" folder preview row and the modal
// live-preview footer. The baseline rows (With series / Without series / Multi-file) render
// edition-free — a normal single copy has no edition label — so `edition` is intentionally NOT
// part of SAMPLE_TOKENS. It is re-attached only where an edition is meant to appear (#1774).
const SAMPLE_EDITION = 'Full Cast';
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
const SAMPLE_TOKENS_MULTIFILE = {
  ...SAMPLE_TOKENS,
  trackNumber: 3, trackTotal: 12, partName: 'Chapter 3',
};

const SEPARATOR_LABELS: Record<NamingSeparator, string> = { space: 'Space', period: 'Period', underscore: 'Underscore', dash: 'Dash' };
const CASE_LABELS: Record<NamingCase, string> = { default: 'Default', lower: 'lowercase', upper: 'UPPERCASE', title: 'Title Case' };


const TOKEN_BOUNDARY_REGEX = new RegExp(`^${TOKEN_PATTERN_SOURCE}$`);

function createFormatKeyDownHandler(
  ref: React.RefObject<HTMLInputElement | null>,
  field: 'folderFormat' | 'fileFormat',
  setFieldValue: (field: 'folderFormat' | 'fileFormat', value: string, options: { shouldDirty: boolean; shouldValidate: boolean }) => void,
) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = ref.current;
    if (!input) return;
    const pos = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? pos;
    if (pos !== end) return;

    const val = input.value;

    if (e.key === 'Backspace' && pos > 0 && val[pos - 1] === '}') {
      const braceStart = val.lastIndexOf('{', pos - 2);
      if (braceStart === -1) return;
      const candidate = val.slice(braceStart, pos);
      if (!TOKEN_BOUNDARY_REGEX.test(candidate)) return;
      e.preventDefault();
      const newValue = val.slice(0, braceStart) + val.slice(pos);
      setFieldValue(field, newValue, { shouldDirty: true, shouldValidate: true });
      requestAnimationFrame(() => { input.setSelectionRange(braceStart, braceStart); input.focus(); });
    } else if (e.key === 'Delete' && pos < val.length && val[pos] === '{') {
      const braceEnd = val.indexOf('}', pos + 1);
      if (braceEnd === -1) return;
      const candidate = val.slice(pos, braceEnd + 1);
      if (!TOKEN_BOUNDARY_REGEX.test(candidate)) return;
      e.preventDefault();
      const newValue = val.slice(0, pos) + val.slice(braceEnd + 1);
      setFieldValue(field, newValue, { shouldDirty: true, shouldValidate: true });
      requestAnimationFrame(() => { input.setSelectionRange(pos, pos); input.focus(); });
    }
  };
}

/**
 * Live-preview derivations for both format editors — extracted from the component solely to keep
 * it under max-lines-per-function; behavior is byte-identical (pure relocation of the memos).
 */
function useNamingPreviews(folderFormat: string | undefined, fileFormat: string | undefined, namingOptions: NamingOptions) {
  const folderPreview = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS, namingOptions) : '', [folderFormat, namingOptions]);
  const folderPreviewNoSeries = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '', [folderFormat, namingOptions]);
  // "Multiple editions" folder row (#1774): mirror `buildTargetPath`'s two branches exactly.
  // If the template places {edition} itself, render it in place (verbatim, no suffix) so the row
  // matches production's double-render guard. Otherwise apply the mandatory collision suffix to the
  // With-series leaf via the real core primitives — byte-identical to the suffix branch by construction.
  const folderPreviewMultiEdition = useMemo(() => {
    if (!folderFormat) return '';
    if (templateHasToken(folderFormat, 'edition')) {
      return renderTemplate(folderFormat, { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION }, namingOptions);
    }
    const discriminator = sanitizeEditionDiscriminator(SAMPLE_EDITION);
    if (!discriminator) return folderPreview;
    const segments = folderPreview.split('/');
    segments[segments.length - 1] = composeEditionSuffixLeaf(segments[segments.length - 1] ?? '', discriminator);
    return segments.join('/');
  }, [folderFormat, namingOptions, folderPreview]);
  const filePreview = useMemo(() => fileFormat ? renderFilename(fileFormat, SAMPLE_TOKENS, namingOptions) : '', [fileFormat, namingOptions]);
  const filePreviewNoSeries = useMemo(() => fileFormat ? renderFilename(fileFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '', [fileFormat, namingOptions]);
  const filePreviewMultiFile = useMemo(() => fileFormat ? renderFilename(fileFormat, SAMPLE_TOKENS_MULTIFILE, namingOptions) : '', [fileFormat, namingOptions]);
  // "With edition" file row (#1819): {edition} is file-supported but never appears in the baseline
  // rows (they render edition-free). Unlike the folder row there is NO automatic-append branch to
  // mirror — files get no side-by-side discriminator. So only render the sample when the template
  // actually places {edition}; otherwise the row would be byte-identical to With-series and read as
  // a bug. When absent, the row teaches the capability with a muted hint instead. `templateHasToken`
  // detects {edition} inside conditional wrappers (e.g. `{ (?edition?)}`), so gating on it is safe.
  const filePreviewEdition = useMemo((): { hasToken: boolean; rendered: string } => {
    const hasToken = !!fileFormat && templateHasToken(fileFormat, 'edition');
    return {
      hasToken,
      rendered: hasToken ? renderFilename(fileFormat!, { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION }, namingOptions) : '',
    };
  }, [fileFormat, namingOptions]);

  return { folderPreview, folderPreviewNoSeries, folderPreviewMultiEdition, filePreview, filePreviewNoSeries, filePreviewMultiFile, filePreviewEdition };
}

// Single source of truth for the card name: shared by the guard label and the SettingsSection title.
const CARD_LABEL = 'File Naming';

export function NamingSettingsSection() {
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);
  const [tokenModalScope, setTokenModalScope] = useState<'folder' | 'file' | null>(null);
  const [folderPanelOpen, setFolderPanelOpen] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(false);

  const { form, mutation, onSubmit } = useSettingsForm<NamingFormData>({
    schema: namingFormSchema,
    defaultValues: {
      folderFormat: DEFAULT_SETTINGS.library.folderFormat,
      fileFormat: DEFAULT_SETTINGS.library.fileFormat,
      namingSeparator: DEFAULT_SETTINGS.library.namingSeparator,
      namingCase: DEFAULT_SETTINGS.library.namingCase,
    },
    select: (s: AppSettings) => ({
      folderFormat: s.library.folderFormat, fileFormat: s.library.fileFormat,
      namingSeparator: s.library.namingSeparator, namingCase: s.library.namingCase,
    }),
    toPayload: (d) => ({ library: d }),
    successMessage: 'File naming settings saved',
    label: CARD_LABEL,
  });

  const { register, handleSubmit, watch, setValue, formState: { errors, isDirty } } = form;

  const folderFormat = watch('folderFormat');
  const fileFormat = watch('fileFormat');
  const namingSeparator = watch('namingSeparator');
  const namingCase = watch('namingCase');

  const namingOptions: NamingOptions = useMemo(() => ({
    separator: namingSeparator ?? 'space', case: namingCase ?? 'default',
  }), [namingSeparator, namingCase]);
  const currentPreset = useMemo(() => detectPreset(folderFormat ?? '', fileFormat ?? ''), [folderFormat, fileFormat]);

  const { folderPreview, folderPreviewNoSeries, folderPreviewMultiEdition, filePreview, filePreviewNoSeries, filePreviewMultiFile, filePreviewEdition } = useNamingPreviews(folderFormat, fileFormat, namingOptions);

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

  // Carry the edition sample into the modal preview so a user who inserts {edition} sees it render
  // (otherwise the modal footer would render it empty — the modal would "lie") (#1774).
  const modalPreviewTokens = useMemo(() =>
    tokenModalScope === 'file'
      ? { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION, trackNumber: 1, trackTotal: 12, partName: 'The Way of Kings' }
      : { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION },
  [tokenModalScope]);

  const folderReg = register('folderFormat');
  const fileReg = register('fileFormat');

  return (
    <SettingsSection icon={<TagIcon className="w-5 h-5 text-primary" />} title={CARD_LABEL} description="Configure how audiobook files and folders are named">
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow htmlFor="namingPreset" label="Preset" description="A starting point — editing the formats below switches this to Custom.">
            <div className="w-48">
              <SelectWithChevron id="namingPreset" value={currentPreset} onChange={(e) => handlePresetChange(e.currentTarget.value)}>
                {NAMING_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                {currentPreset === 'custom' && <option value="custom">Custom</option>}
              </SelectWithChevron>
            </div>
          </SettingsRow>

          <SettingsRow htmlFor="namingSeparator" label="Separator" description="Character used between words in generated names.">
            <div className="w-48">
              <SelectWithChevron id="namingSeparator" {...register('namingSeparator')}>
                {namingSeparatorValues.map((v) => <option key={v} value={v}>{SEPARATOR_LABELS[v]}</option>)}
              </SelectWithChevron>
            </div>
          </SettingsRow>

          <SettingsRow htmlFor="namingCase" label="Case" description="Letter casing applied to generated names.">
            <div className="w-48">
              <SelectWithChevron id="namingCase" {...register('namingCase')}>
                {namingCaseValues.map((v) => <option key={v} value={v}>{CASE_LABELS[v]}</option>)}
              </SelectWithChevron>
            </div>
          </SettingsRow>

          <SettingsRow
            layout="stacked"
            label={<FormatFieldHeader text="Folder format" ariaLabel="Folder token reference" onOpenTokenModal={() => setTokenModalScope('folder')} />}
            description="Template for audiobook folder paths."
          >
            <FormatField
              id="folderFormat" inputAriaLabel="Folder format" placeholder="{author}/{title}"
              error={errors.folderFormat} preview={folderPreview} previewNoSeries={folderPreviewNoSeries} previewMultiEdition={folderPreviewMultiEdition} hasValue={!!folderFormat}
              previewNote={
                <p className="mt-2 text-xs text-muted-foreground">
                  Multiple editions of a book are kept side-by-side automatically — narratorr appends the edition to the folder. Add {'{edition}'} above to control where it appears.
                </p>
              }
              onInsertToken={(token) => insertTokenAtCursor(folderFormatRef, 'folderFormat', token)}
              onKeyDown={(e) => createFormatKeyDownHandler(folderFormatRef, 'folderFormat', setValue)(e)}
              tokenGroups={FOLDER_TOKEN_GROUPS}
              inlinePanelOpen={folderPanelOpen}
              onToggleInlinePanel={() => setFolderPanelOpen((v) => !v)}
              registerProps={{ ...folderReg, ref: undefined }}
              inputRef={(el) => { folderReg.ref(el); folderFormatRef.current = el; }}
              warnings={<>
                {!hasTitleToken && <p className="text-sm text-destructive mt-1.5">{FOLDER_TITLE_MSG}</p>}
                {hasTitleToken && !hasAuthorToken && <p className="text-sm text-amber-500 mt-1.5">{AUTHOR_ADVISORY_MSG}</p>}
              </>}
            />
          </SettingsRow>

          <SettingsRow
            layout="stacked"
            label={<FormatFieldHeader text="File format" ariaLabel="File token reference" onOpenTokenModal={() => setTokenModalScope('file')} />}
            description="Template for audio file names."
          >
            <FormatField
              id="fileFormat" inputAriaLabel="File format" placeholder="{author} - {title}"
              error={errors.fileFormat} preview={filePreview} previewNoSeries={filePreviewNoSeries} previewMultiFile={filePreviewMultiFile} previewFileEdition={filePreviewEdition} previewSuffix=".m4b" previewSuffixMultiFile=".mp3" hasValue={!!fileFormat}
              onInsertToken={(token) => insertTokenAtCursor(fileFormatRef, 'fileFormat', token)}
              onKeyDown={(e) => createFormatKeyDownHandler(fileFormatRef, 'fileFormat', setValue)(e)}
              tokenGroups={[...FOLDER_TOKEN_GROUPS, FILE_ONLY_TOKEN_GROUP]}
              inlinePanelOpen={filePanelOpen}
              onToggleInlinePanel={() => setFilePanelOpen((v) => !v)}
              registerProps={{ ...fileReg, ref: undefined }}
              inputRef={(el) => { fileReg.ref(el); fileFormatRef.current = el; }}
              warnings={!fileTitleToken ? <p className="text-sm text-destructive mt-1.5">{FOLDER_TITLE_MSG}</p> : null}
            />
          </SettingsRow>
        </SettingsTable>

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
