import { useMemo, useRef, useState } from 'react';
import { SAMPLE_TOKENS_FILE_MODAL, SAMPLE_TOKENS_FOLDER_MODAL } from '@/lib/naming-samples';

export type TokenScope = 'folder' | 'file';
export type FormatField = 'folderFormat' | 'fileFormat';

/** Structural, not `UseFormSetValue`, so a caller can pass any equivalent setter. */
export type SetFormatValue = (field: FormatField, value: string, options: { shouldDirty: boolean; shouldValidate: boolean }) => void;

/**
 * Token insertion for the naming format fields: the two input refs, the scope that decides
 * which one a token lands in, and what the token modal derives from that scope.
 *
 * The refs are the load-bearing part — insertion reads the live cursor position off the
 * mounted input, so it silently no-ops whenever the caller has unmounted the fields.
 */
export function useTokenInsertion(setFieldValue: SetFormatValue, folderFormat: string | undefined, fileFormat: string | undefined) {
  const folderFormatRef = useRef<HTMLInputElement | null>(null);
  const fileFormatRef = useRef<HTMLInputElement | null>(null);
  const [tokenModalScope, setTokenModalScope] = useState<TokenScope | null>(null);

  const insertTokenAtCursor = (ref: React.RefObject<HTMLInputElement | null>, field: FormatField, token: string) => {
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const newValue = `${input.value.slice(0, start)}{${token}}${input.value.slice(end)}`;
    setFieldValue(field, newValue, { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => { input.setSelectionRange(start + token.length + 2, start + token.length + 2); input.focus(); });
  };

  const handleTokenModalInsert = (token: string) => {
    if (tokenModalScope === 'folder') insertTokenAtCursor(folderFormatRef, 'folderFormat', token);
    else if (tokenModalScope === 'file') insertTokenAtCursor(fileFormatRef, 'fileFormat', token);
  };

  const modalPreviewTokens = useMemo(
    () => (tokenModalScope === 'file' ? SAMPLE_TOKENS_FILE_MODAL : SAMPLE_TOKENS_FOLDER_MODAL),
    [tokenModalScope],
  );

  return {
    folderFormatRef, fileFormatRef, tokenModalScope, insertTokenAtCursor, handleTokenModalInsert, modalPreviewTokens,
    openTokenModal: (scope: TokenScope) => setTokenModalScope(scope),
    closeTokenModal: () => setTokenModalScope(null),
    // 'folder' is the modal's own default; scope only reads null while it is closed.
    modalScope: tokenModalScope ?? 'folder',
    modalCurrentFormat: (tokenModalScope === 'file' ? fileFormat : folderFormat) ?? '',
  };
}
