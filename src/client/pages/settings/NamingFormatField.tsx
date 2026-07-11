import type { ReactNode } from 'react';
import { type FieldError } from 'react-hook-form';
import { ChevronRightIcon } from '@/components/icons';
import { errorInputClass } from '@/components/settings/formStyles';
import type { TokenGroup } from '@core/utils/naming.js';

// Extracted from NamingSettingsSection (the row-table conversion pushed it over the 400-line
// max-lines cap) — the format-template EDITOR: mono input with token-aware keydown, error,
// warnings, collapsible token panel, and the multi-variant live preview block.

export interface FormatFieldProps {
  id: string;
  placeholder: string;
  error?: FieldError | undefined;
  preview: string;
  previewNoSeries: string;
  previewMultiFile?: string | undefined;
  previewMultiEdition?: string | undefined;
  previewFileEdition?: { hasToken: boolean; rendered: string } | undefined;
  previewSuffix?: string | undefined;
  previewSuffixMultiFile?: string | undefined;
  previewNote?: ReactNode;
  warnings?: ReactNode;
  onInsertToken: (token: string) => void;
  tokenGroups: readonly TokenGroup[];
  inlinePanelOpen: boolean;
  onToggleInlinePanel: () => void;
  registerProps: Record<string, unknown>;
  inputRef: (el: HTMLInputElement | null) => void;
  hasValue: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** Row-header content for a format editor: label text + the "?" token-reference modal button. */
export function FormatFieldHeader({ text, ariaLabel, onOpenTokenModal }: { text: string; ariaLabel: string; onOpenTokenModal: () => void }) {
  return (
    <span className="inline-flex items-center gap-2">
      {text}
      <button
        type="button"
        onClick={onOpenTokenModal}
        className="w-5 h-5 rounded-full bg-muted hover:bg-muted/80 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
        aria-label={ariaLabel}
      >
        ?
      </button>
    </span>
  );
}

// The label row lives in the wrapping SettingsRow header (span variant — a <label> may not
// contain the "?" button, interactive content is invalid inside labels). FormatField renders
// only the editor body: input, warnings, token panel, previews.
export function FormatField({ id, placeholder, error, preview, previewNoSeries, previewMultiFile, previewMultiEdition, previewFileEdition, previewSuffix, previewSuffixMultiFile, previewNote, warnings, onInsertToken, tokenGroups, inlinePanelOpen, onToggleInlinePanel, registerProps, inputRef, hasValue, onKeyDown }: FormatFieldProps) {
  const panelId = `${id}-token-panel`;
  return (
    <div>
      <input
        id={id}
        type="text"
        {...registerProps}
        ref={inputRef}
        onKeyDown={onKeyDown}
        className={`${errorInputClass(!!error)} font-mono text-sm`}
        placeholder={placeholder}
      />
      {error && <p className="text-sm text-destructive mt-1">{error.message}</p>}
      {warnings}
      <button
        type="button"
        onClick={onToggleInlinePanel}
        aria-expanded={inlinePanelOpen}
        aria-controls={panelId}
        aria-label={`Toggle ${id === 'folderFormat' ? 'folder' : 'file'} tokens`}
        className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <ChevronRightIcon className={`w-3.5 h-3.5 transition-transform duration-200 ${inlinePanelOpen ? 'rotate-90' : ''}`} />
        <span>Tokens</span>
      </button>
      {inlinePanelOpen && (
        <div id={panelId} className="mt-1.5 p-3 bg-muted/30 rounded-lg border border-border/50 space-y-2">
          {tokenGroups.map((group) => (
            <div key={group.label}>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                {group.label}
              </h4>
              <div className="flex flex-wrap gap-1">
                {group.tokens.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => onInsertToken(token)}
                    className="px-2 py-0.5 bg-muted hover:bg-muted/80 text-xs font-mono rounded transition-colors cursor-pointer hover:ring-1 hover:ring-primary/30"
                  >
                    {`{${token}}`}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {hasValue && (
        <div className="mt-2 p-3 bg-muted/50 rounded-lg border border-border space-y-1">
          <div className="flex items-baseline gap-3">
            <span className="w-24 text-right shrink-0 text-xs text-muted-foreground">With series</span>
            <span data-testid="preview-with-series" className="text-sm font-mono break-all">
              {preview ? <>{preview}{previewSuffix}</> : <span className="text-muted-foreground italic">Empty</span>}
            </span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="w-24 text-right shrink-0 text-xs text-muted-foreground">Without series</span>
            <span data-testid="preview-without-series" className="text-sm font-mono break-all">
              {previewNoSeries ? <>{previewNoSeries}{previewSuffix}</> : <span className="text-muted-foreground italic">Empty</span>}
            </span>
          </div>
          {previewMultiFile !== undefined && (
            <div className="flex items-baseline gap-3">
              <span className="w-24 text-right shrink-0 text-xs text-muted-foreground">Multi-file</span>
              <span data-testid="preview-multi-file" className="text-sm font-mono break-all">
                {previewMultiFile ? <>{previewMultiFile}{previewSuffixMultiFile ?? previewSuffix}</> : <span className="text-muted-foreground italic">Empty</span>}
              </span>
            </div>
          )}
          {previewMultiEdition !== undefined && (
            <div className="flex items-baseline gap-3">
              <span className="w-24 text-right shrink-0 text-xs text-muted-foreground">Multiple editions</span>
              <span data-testid="preview-multi-edition" className="text-sm font-mono break-all">
                {previewMultiEdition ? previewMultiEdition : <span className="text-muted-foreground italic">Empty</span>}
              </span>
            </div>
          )}
          {previewFileEdition !== undefined && (
            <div className="flex items-baseline gap-3">
              <span className="w-24 text-right shrink-0 text-xs text-muted-foreground">With edition</span>
              <span data-testid="preview-file-edition" className="text-sm font-mono break-all">
                {previewFileEdition.hasToken
                  ? <>{previewFileEdition.rendered}{previewSuffix}</>
                  : <span className="text-muted-foreground italic">Add {'{edition}'} to include the edition label in filenames</span>}
              </span>
            </div>
          )}
        </div>
      )}
      {previewNote}
    </div>
  );
}
