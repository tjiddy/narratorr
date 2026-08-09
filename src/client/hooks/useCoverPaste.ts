import { useEffect, useCallback } from 'react';
import { MAX_COVER_SIZE } from '@shared/constants.js';

function isEditableActive(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (el.getAttribute('contenteditable') === 'true') return true;
  return false;
}

interface UseCoverPasteOptions {
  enabled: boolean;
  onPaste: (file: File) => void;
  onError?: (message: string) => void;
}

/** Handles document-level image pastes without stealing paste from editable controls. */
export function useCoverPaste({ enabled, onPaste, onError }: UseCoverPasteOptions) {
  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (isEditableActive()) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;

        if (file.size > MAX_COVER_SIZE) {
          onError?.('Cover image must be under 10 MB');
          return;
        }

        onPaste(file);
        return;
      }
    }
  }, [onPaste, onError]);

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [enabled, handlePaste]);
}
