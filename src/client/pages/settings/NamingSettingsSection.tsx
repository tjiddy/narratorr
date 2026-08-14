import { useMemo, useState } from 'react';
import { TagIcon } from '@/components/icons';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useTokenInsertion, type SetFormatValue } from '@/hooks/useTokenInsertion';
import { SAMPLE_EDITION, SAMPLE_TOKENS, SAMPLE_TOKENS_MULTIFILE, SAMPLE_TOKENS_NO_SERIES } from '@/lib/naming-samples';
import { NamingTokenModal } from '@/components/settings/NamingTokenModal';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { FormatField, FormatFieldHeader } from './NamingFormatField';
import { renderTemplate, renderFilename, NAMING_PRESETS, detectPreset, FOLDER_TOKEN_GROUPS, FILE_ONLY_TOKEN_GROUP, TOKEN_PATTERN_SOURCE, templateHasToken, composeEditionSuffixLeaf, sanitizeEditionDiscriminator } from '@core/utils/index.js';
import { DEFAULT_SETTINGS, namingSeparatorValues, namingCaseValues, namingFormSchema, hasTitle, hasAuthor, FOLDER_TITLE_MSG, AUTHOR_ADVISORY_MSG, type AppSettings } from '@shared/schemas.js';
import type { NamingSeparator, NamingCase } from '@shared/schemas/settings/library.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { SettingsSection } from './SettingsSection';
import type { z } from 'zod';

type NamingFormData = z.infer<typeof namingFormSchema>;

const SEPARATOR_LABELS: Record<NamingSeparator, string> = { space: 'Space', period: 'Period', underscore: 'Underscore', dash: 'Dash' };
const CASE_LABELS: Record<NamingCase, string> = { default: 'Default', lower: 'lowercase', upper: 'UPPERCASE', title: 'Title Case' };


const TOKEN_BOUNDARY_REGEX = new RegExp(`^${TOKEN_PATTERN_SOURCE}$`);

function createFormatKeyDownHandler(
  ref: React.RefObject<HTMLInputElement | null>,
  field: 'folderFormat' | 'fileFormat',
  setFieldValue: SetFormatValue,
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

function useNamingPreviews(folderFormat: string | undefined, fileFormat: string | undefined, namingOptions: NamingOptions) {
  const folderPreview = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS, namingOptions) : '', [folderFormat, namingOptions]);
  const folderPreviewNoSeries = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '', [folderFormat, namingOptions]);
  // Match buildTargetPath: explicit {edition} renders in place; otherwise suffix the folder leaf.
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
  // Files never auto-append edition, so render it only when the template contains the token.
  const filePreviewEdition = useMemo((): { hasToken: boolean; rendered: string } => {
    const hasToken = !!fileFormat && templateHasToken(fileFormat, 'edition');
    return {
      hasToken,
      rendered: hasToken ? renderFilename(fileFormat!, { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION }, namingOptions) : '',
    };
  }, [fileFormat, namingOptions]);

  return { folderPreview, folderPreviewNoSeries, folderPreviewMultiEdition, filePreview, filePreviewNoSeries, filePreviewMultiFile, filePreviewEdition };
}

const CARD_LABEL = 'File Naming';

export function NamingSettingsSection() {
  const [folderPanelOpen, setFolderPanelOpen] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(false);

  const { form, mutation, onSubmit, settingsError, refetchSettings } = useSettingsForm<NamingFormData>({
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

  const {
    folderFormatRef, fileFormatRef, tokenModalScope, insertTokenAtCursor, handleTokenModalInsert,
    modalPreviewTokens, openTokenModal, closeTokenModal, modalScope, modalCurrentFormat,
  } = useTokenInsertion(setValue, folderFormat, fileFormat);

  const namingOptions: NamingOptions = useMemo(() => ({
    separator: namingSeparator ?? 'space', case: namingCase ?? 'default',
  }), [namingSeparator, namingCase]);
  const currentPreset = useMemo(() => detectPreset(folderFormat ?? '', fileFormat ?? ''), [folderFormat, fileFormat]);

  const { folderPreview, folderPreviewNoSeries, folderPreviewMultiEdition, filePreview, filePreviewNoSeries, filePreviewMultiFile, filePreviewEdition } = useNamingPreviews(folderFormat, fileFormat, namingOptions);

  const hasTitleToken = folderFormat ? hasTitle(folderFormat) : true;
  const hasAuthorToken = folderFormat ? hasAuthor(folderFormat) : true;
  const fileTitleToken = fileFormat ? hasTitle(fileFormat) : true;

  const handlePresetChange = (presetId: string) => {
    const preset = NAMING_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setValue('folderFormat', preset.folderFormat, { shouldDirty: true, shouldValidate: true });
    setValue('fileFormat', preset.fileFormat, { shouldDirty: true, shouldValidate: true });
  };

  const folderReg = register('folderFormat');
  const fileReg = register('fileFormat');

  return (
    <SettingsSection icon={<TagIcon className="w-5 h-5 text-primary" />} title={CARD_LABEL} description="Configure how audiobook files and folders are named">
      {/* "{author}/{title}" in Folder format reads as the operator's template, and the previews
          beneath it as their real output — both are schema defaults a failed read never observed. */}
      {settingsError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load file naming settings.</p>
          <button
            type="button"
            onClick={refetchSettings}
            aria-label="Retry loading file naming settings"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : (
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
              label={<FormatFieldHeader text="Folder format" ariaLabel="Folder token reference" onOpenTokenModal={() => openTokenModal('folder')} />}
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
              label={<FormatFieldHeader text="File format" ariaLabel="File token reference" onOpenTokenModal={() => openTokenModal('file')} />}
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
      )}
      {/* Derived, not cleared in an effect: the scope survives the error so a successful Retry
          returns the operator to their place. Left visible, its token buttons would insert into
          refs RHF has just nulled and no-op silently at the guard in insertTokenAtCursor. */}
      <NamingTokenModal
        isOpen={tokenModalScope !== null && !settingsError} onClose={closeTokenModal} onInsert={handleTokenModalInsert}
        scope={modalScope} currentFormat={modalCurrentFormat}
        previewTokens={modalPreviewTokens} namingOptions={namingOptions}
      />
    </SettingsSection>
  );
}
