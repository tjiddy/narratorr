import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCoverPaste } from './useCoverPaste';

function createPasteEvent(items: DataTransferItem[] = []): ClipboardEvent {
  const clipboardData = {
    items: items as unknown as DataTransferItemList,
  };
  const event = new Event('paste', { bubbles: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  return event;
}

function createImageItem(type = 'image/png', size = 1024): DataTransferItem {
  const file = new File([new ArrayBuffer(size)], 'image.png', { type });
  return {
    kind: 'file',
    type,
    getAsFile: () => file,
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn(),
  } as unknown as DataTransferItem;
}

function createTextItem(): DataTransferItem {
  return {
    kind: 'string',
    type: 'text/plain',
    getAsFile: () => null,
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn(),
  } as unknown as DataTransferItem;
}

describe('useCoverPaste', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('adds paste event listener on mount', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const onPaste = vi.fn();

      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      expect(addSpy).toHaveBeenCalledWith('paste', expect.any(Function));
    });

    it('removes paste event listener on cleanup', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const onPaste = vi.fn();

      const { unmount } = renderHook(() => useCoverPaste({ enabled: true, onPaste }));
      unmount();

      expect(removeSpy).toHaveBeenCalledWith('paste', expect.any(Function));
    });

    it('does not attach listener when enabled is false', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const onPaste = vi.fn();

      renderHook(() => useCoverPaste({ enabled: false, onPaste }));

      expect(addSpy).not.toHaveBeenCalledWith('paste', expect.any(Function));
    });
  });

  describe('paste handling', () => {
    it('invokes callback with File when paste contains image item', () => {
      const onPaste = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      const event = createPasteEvent([createImageItem()]);
      document.dispatchEvent(event);

      expect(onPaste).toHaveBeenCalledTimes(1);
      expect(onPaste).toHaveBeenCalledWith(expect.any(File));
    });

    it('does not invoke callback for non-image paste', () => {
      const onPaste = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      const event = createPasteEvent([createTextItem()]);
      document.dispatchEvent(event);

      expect(onPaste).not.toHaveBeenCalled();
    });

    it('does not invoke callback when paste has no items', () => {
      const onPaste = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      const event = createPasteEvent([]);
      document.dispatchEvent(event);

      expect(onPaste).not.toHaveBeenCalled();
    });

    it('invokes error callback when pasted image exceeds 10 MB', () => {
      const onPaste = vi.fn();
      const onError = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste, onError }));

      const oversizedItem = createImageItem('image/png', 10 * 1024 * 1024 + 1);
      const event = createPasteEvent([oversizedItem]);
      document.dispatchEvent(event);

      expect(onPaste).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('Cover image must be under 10 MB');
    });
  });

  describe('editable control exemption', () => {
    it('does not invoke callback when activeElement is an input', () => {
      const onPaste = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const event = createPasteEvent([createImageItem()]);
      document.dispatchEvent(event);

      expect(onPaste).not.toHaveBeenCalled();
      document.body.removeChild(input);
    });

    it('does not invoke callback when activeElement is a textarea', () => {
      const onPaste = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      const event = createPasteEvent([createImageItem()]);
      document.dispatchEvent(event);

      expect(onPaste).not.toHaveBeenCalled();
      document.body.removeChild(textarea);
    });

    it('does not invoke callback when activeElement has contenteditable', () => {
      const onPaste = vi.fn();
      renderHook(() => useCoverPaste({ enabled: true, onPaste }));

      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      div.tabIndex = 0;
      document.body.appendChild(div);
      div.focus();

      const event = createPasteEvent([createImageItem()]);
      document.dispatchEvent(event);

      expect(onPaste).not.toHaveBeenCalled();
      document.body.removeChild(div);
    });
  });
});
