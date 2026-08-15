import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTokenInsertion } from './useTokenInsertion';

const DIRTY_AND_VALIDATE = { shouldDirty: true, shouldValidate: true };

function mountInput(value: string, selection?: [number, number]): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  document.body.appendChild(input);
  input.setSelectionRange(...(selection ?? [value.length, value.length]));
  return input;
}

function setup(folderFormat = '{author}/{title}', fileFormat = '{author} - {title}') {
  const setFieldValue = vi.fn();
  const view = renderHook(() => useTokenInsertion(setFieldValue, folderFormat, fileFormat));
  return { setFieldValue, ...view };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useTokenInsertion', () => {
  describe('insertTokenAtCursor', () => {
    it('splices the token in at the caret and marks the field dirty and validated', () => {
      const { result, setFieldValue } = setup();
      const input = mountInput('{author}/', [9, 9]);
      result.current.folderFormatRef.current = input;

      act(() => result.current.insertTokenAtCursor(result.current.folderFormatRef, 'folderFormat', 'title'));

      expect(setFieldValue).toHaveBeenCalledWith('folderFormat', '{author}/{title}', DIRTY_AND_VALIDATE);
    });

    it('replaces the selected range rather than inserting beside it', () => {
      const { result, setFieldValue } = setup();
      // Select the "{title}" half of "{author}/{title}".
      const input = mountInput('{author}/{title}', [9, 16]);
      result.current.folderFormatRef.current = input;

      act(() => result.current.insertTokenAtCursor(result.current.folderFormatRef, 'folderFormat', 'series'));

      expect(setFieldValue).toHaveBeenCalledWith('folderFormat', '{author}/{series}', DIRTY_AND_VALIDATE);
    });

    it('no-ops when the field is unmounted, rather than writing against a stale value', () => {
      const { result, setFieldValue } = setup();
      // What a gated-away form leaves behind: RHF's ref callback has nulled this.
      result.current.folderFormatRef.current = null;

      act(() => result.current.insertTokenAtCursor(result.current.folderFormatRef, 'folderFormat', 'title'));

      expect(setFieldValue).not.toHaveBeenCalled();
    });
  });

  describe('handleTokenModalInsert', () => {
    it('routes to the folder field while the folder modal is open', () => {
      const { result, setFieldValue } = setup();
      const folder = mountInput('{author}/');
      const file = mountInput('{title}');
      result.current.folderFormatRef.current = folder;
      result.current.fileFormatRef.current = file;

      act(() => result.current.openTokenModal('folder'));
      act(() => result.current.handleTokenModalInsert('title'));

      expect(setFieldValue).toHaveBeenCalledTimes(1);
      expect(setFieldValue).toHaveBeenCalledWith('folderFormat', '{author}/{title}', DIRTY_AND_VALIDATE);
    });

    it('routes to the file field while the file modal is open', () => {
      const { result, setFieldValue } = setup();
      const folder = mountInput('{author}/');
      const file = mountInput('{title}');
      result.current.folderFormatRef.current = folder;
      result.current.fileFormatRef.current = file;

      act(() => result.current.openTokenModal('file'));
      act(() => result.current.handleTokenModalInsert('edition'));

      expect(setFieldValue).toHaveBeenCalledTimes(1);
      expect(setFieldValue).toHaveBeenCalledWith('fileFormat', '{title}{edition}', DIRTY_AND_VALIDATE);
    });

    it('writes to neither field while the modal is closed', () => {
      const { result, setFieldValue } = setup();
      result.current.folderFormatRef.current = mountInput('{author}/');
      result.current.fileFormatRef.current = mountInput('{title}');

      act(() => result.current.handleTokenModalInsert('title'));

      expect(setFieldValue).not.toHaveBeenCalled();
    });
  });

  describe('modal derivations', () => {
    it('reports a closed modal as folder-scoped so the modal can render its own default', () => {
      const { result } = setup();

      expect(result.current.tokenModalScope).toBeNull();
      expect(result.current.modalScope).toBe('folder');
      expect(result.current.modalCurrentFormat).toBe('{author}/{title}');
    });

    it("follows the open scope to that field's current format", () => {
      const { result } = setup();

      act(() => result.current.openTokenModal('file'));

      expect(result.current.modalScope).toBe('file');
      expect(result.current.modalCurrentFormat).toBe('{author} - {title}');
      expect(result.current.modalPreviewTokens).toMatchObject({ trackNumber: 1, edition: 'Full Cast' });
    });

    it('falls back to an empty format when the watched value is undefined', () => {
      const setFieldValue = vi.fn();
      const { result } = renderHook(() => useTokenInsertion(setFieldValue, undefined, undefined));

      expect(result.current.modalCurrentFormat).toBe('');
    });

    it('closes back to null scope without touching either format', () => {
      const { result, setFieldValue } = setup();

      act(() => result.current.openTokenModal('file'));
      act(() => result.current.closeTokenModal());

      expect(result.current.tokenModalScope).toBeNull();
      expect(setFieldValue).not.toHaveBeenCalled();
    });
  });
});
