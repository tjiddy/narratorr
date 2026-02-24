import { useRef, useMemo, useState } from 'react';
import type { UseFormRegister, UseFormSetValue, UseFormWatch, FieldErrors } from 'react-hook-form';
import { FolderIcon } from '@/components/icons';
import { renderTemplate, renderFilename, toLastFirst, toSortTitle, ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from '@narratorr/core/utils';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

interface LibrarySettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
  setValue: UseFormSetValue<UpdateSettingsFormData>;
  watch: UseFormWatch<UpdateSettingsFormData>;
}

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
export function LibrarySettingsSection({ register, errors, setValue, watch }: LibrarySettingsSectionProps) {
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);

  const folderFormat = watch('library.folderFormat');
  const fileFormat = watch('library.fileFormat');

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

  const hasTitleToken = folderFormat ? /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const hasAuthorToken = folderFormat ? /\{author(?:LastFirst)?(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const fileTitleToken = fileFormat ? /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(fileFormat) : true;

  const insertTokenAtCursor = (
    ref: React.RefObject<HTMLInputElement | null>,
    field: 'library.folderFormat' | 'library.fileFormat',
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
    insertTokenAtCursor(folderFormatRef, 'library.folderFormat', token);
  };

  const insertFileToken = (token: string) => {
    insertTokenAtCursor(fileFormatRef, 'library.fileFormat', token);
  };

  return (
    <SettingsSection
      icon={<FolderIcon className="w-5 h-5 text-primary" />}
      title="Library"
      description="Configure where audiobooks are stored"
    >
      <div>
        <label htmlFor="libraryPath" className="block text-sm font-medium mb-2">Library Path</label>
        <input
          id="libraryPath"
          type="text"
          {...register('library.path')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.library?.path ? 'border-destructive' : 'border-border'
          }`}
          placeholder="/audiobooks"
        />
        {errors.library?.path && (
          <p className="text-sm text-destructive mt-1">{errors.library.path.message}</p>
        )}
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
              const { ref: rhfRef, ...rest } = register('library.folderFormat');
              return {
                ...rest,
                ref: (el: HTMLInputElement | null) => {
                  rhfRef(el);
                  folderFormatRef.current = el;
                },
              };
            })()}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
              errors.library?.folderFormat ? 'border-destructive' : 'border-border'
            }`}
            placeholder="{author}/{title}"
          />
          {errors.library?.folderFormat && (
            <p className="text-sm text-destructive mt-1">{errors.library.folderFormat.message}</p>
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
              const { ref: rhfRef, ...rest } = register('library.fileFormat');
              return {
                ...rest,
                ref: (el: HTMLInputElement | null) => {
                  rhfRef(el);
                  fileFormatRef.current = el;
                },
              };
            })()}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
              errors.library?.fileFormat ? 'border-destructive' : 'border-border'
            }`}
            placeholder="{author} - {title}"
          />
          {errors.library?.fileFormat && (
            <p className="text-sm text-destructive mt-1">{errors.library.fileFormat.message}</p>
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
        <div className="p-3 bg-muted/50 rounded-lg border border-border">
          <p className="text-xs text-muted-foreground mb-1">Preview</p>
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
      )}
    </SettingsSection>
  );
}
