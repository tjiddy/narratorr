import { useRef, useMemo } from 'react';
import type { UseFormRegister, UseFormSetValue, UseFormWatch, FieldErrors } from 'react-hook-form';
import { FolderIcon } from '@/components/icons';
import { renderTemplate, ALLOWED_TOKENS } from '@narratorr/core/utils';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

interface LibrarySettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
  setValue: UseFormSetValue<UpdateSettingsFormData>;
  watch: UseFormWatch<UpdateSettingsFormData>;
}

// eslint-disable-next-line complexity -- folder format validation + token insertion + preview logic
export function LibrarySettingsSection({ register, errors, setValue, watch }: LibrarySettingsSectionProps) {
  const folderFormatRef = useRef<HTMLInputElement | null>(null);

  const folderFormat = watch('library.folderFormat');

  const previewPath = useMemo(() => {
    if (!folderFormat) return '';
    return renderTemplate(folderFormat, {
      author: 'Brandon Sanderson',
      title: 'The Way of Kings',
      series: 'The Stormlight Archive',
      seriesPosition: 1,
      year: '2010',
      narrator: 'Michael Kramer, Kate Reading',
    });
  }, [folderFormat]);

  const hasTitleToken = folderFormat ? /\{title(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const hasAuthorToken = folderFormat ? /\{author(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;

  const insertToken = (token: string) => {
    const input = folderFormatRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const newValue = `${before}{${token}}${after}`;
    setValue('library.folderFormat', newValue, { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => {
      const pos = start + token.length + 2;
      input.setSelectionRange(pos, pos);
      input.focus();
    });
  };

  return (
    <SettingsSection
      icon={<FolderIcon className="w-5 h-5 text-primary" />}
      title="Library"
      description="Configure where audiobooks are stored"
    >
      <div>
        <label className="block text-sm font-medium mb-2">Library Path</label>
        <input
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

      <div>
        <label className="block text-sm font-medium mb-2">Folder Format</label>
        <input
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

        <div className="flex flex-wrap gap-1.5 mt-2">
          {ALLOWED_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => insertToken(token)}
              className="px-2 py-1 bg-muted hover:bg-muted/80 text-xs font-mono rounded-md transition-colors cursor-pointer"
            >
              {`{${token}}`}
            </button>
          ))}
        </div>

        {!hasTitleToken && (
          <p className="text-sm text-destructive mt-2">
            Template must include {'{title}'}
          </p>
        )}
        {hasTitleToken && !hasAuthorToken && (
          <p className="text-sm text-amber-500 mt-2">
            Consider including {'{author}'} for better organization
          </p>
        )}

        {folderFormat && (
          <div className="mt-3 p-3 bg-muted/50 rounded-lg border border-border">
            <p className="text-xs text-muted-foreground mb-1">Preview</p>
            <p className="text-sm font-mono break-all">{previewPath || <span className="text-muted-foreground italic">Empty path</span>}</p>
          </div>
        )}

        <p className="text-sm text-muted-foreground mt-2">
          Use conditional blocks like <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{series? - }'}</code> to add separators only when a value exists.
          Use <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{seriesPosition:00}'}</code> for zero-padding.
        </p>
      </div>
    </SettingsSection>
  );
}
