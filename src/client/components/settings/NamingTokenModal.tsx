import { useMemo } from 'react';
import { Modal } from '@/components/Modal';
import { XIcon } from '@/components/icons';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { renderTemplate, renderFilename, FOLDER_TOKEN_GROUPS, FILE_ONLY_TOKEN_GROUP } from '@core/utils/index.js';
import type { NamingOptions, TokenGroup } from '@core/utils/naming.js';

interface NamingTokenModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (token: string) => void;
  scope: 'folder' | 'file';
  currentFormat: string;
  previewTokens: Record<string, string | number | undefined | null>;
  namingOptions?: NamingOptions;
}

export function NamingTokenModal({
  isOpen,
  onClose,
  onInsert,
  scope,
  currentFormat,
  previewTokens,
  namingOptions,
}: NamingTokenModalProps) {
  useEscapeKey(isOpen, onClose);

  const groups: readonly TokenGroup[] = useMemo(() => {
    return scope === 'file' ? [...FOLDER_TOKEN_GROUPS, FILE_ONLY_TOKEN_GROUP] : FOLDER_TOKEN_GROUPS;
  }, [scope]);

  const preview = useMemo(() => {
    if (!currentFormat) return '';
    if (scope === 'folder') {
      return renderTemplate(currentFormat, previewTokens, namingOptions);
    }
    return renderFilename(currentFormat, previewTokens, namingOptions);
  }, [currentFormat, previewTokens, scope, namingOptions]);

  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} className="w-full max-w-lg" scrollable>
      <div className="flex items-center justify-between p-4 border-b border-border/30">
        <h2 className="text-lg font-semibold">
          {scope === 'folder' ? 'Folder' : 'File'} Token Reference
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-muted transition-colors cursor-pointer"
          aria-label="Close"
        >
          <XIcon className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Token groups */}
        {groups.map((group) => (
          <div key={group.label}>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              {group.label}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {group.tokens.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => onInsert(token)}
                  className="px-2.5 py-1 bg-muted hover:bg-muted/80 text-sm font-mono rounded-lg transition-colors cursor-pointer hover:ring-1 hover:ring-primary/30"
                >
                  {`{${token}}`}
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* Syntax reference */}
        <div className="pt-3 border-t border-border/30">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Syntax Reference
          </h3>
          <div className="space-y-1.5 text-sm">
            <div className="flex gap-3">
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono shrink-0">{'{token}'}</code>
              <span className="text-muted-foreground">Simple replacement</span>
            </div>
            <div className="flex gap-3">
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono shrink-0">{'{token:00}'}</code>
              <span className="text-muted-foreground">Zero-padded number (e.g., 01, 02)</span>
            </div>
            <div className="flex gap-3">
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono shrink-0">{'{token? text}'}</code>
              <span className="text-muted-foreground">Conditional — includes text only if token has value</span>
            </div>
          </div>
        </div>

        {/* Good to know */}
        <div className="pt-3 border-t border-border/30">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Good to know
          </h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>Consecutive spaces are collapsed to a single space</li>
            <li>Illegal filesystem characters are automatically stripped</li>
            <li>Path segments are truncated to 255 characters</li>
          </ul>
        </div>
      </div>

      {/* Sticky footer with preview */}
      <div className="p-3 border-t border-border/30 bg-muted/30">
        <p className="text-xs text-muted-foreground mb-1">Preview</p>
        <p className="text-sm font-mono break-all">
          {preview || <span className="text-muted-foreground italic">Empty format</span>}
          {scope === 'file' && preview ? '.m4b' : ''}
        </p>
      </div>
    </Modal>
  );
}
