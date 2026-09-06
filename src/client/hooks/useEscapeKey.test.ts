import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEscapeKey } from './useEscapeKey';

describe('useEscapeKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onEscape when Escape key is pressed while isOpen is true', () => {
    const onEscape = vi.fn();

    renderHook(() => useEscapeKey(true, onEscape));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('does not call onEscape when isOpen is false', () => {
    const onEscape = vi.fn();

    renderHook(() => useEscapeKey(false, onEscape));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('does not call onEscape for non-Escape keys', () => {
    const onEscape = vi.fn();

    renderHook(() => useEscapeKey(true, onEscape));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('cleans up event listener on unmount', () => {
    const onEscape = vi.fn();

    const { unmount } = renderHook(() => useEscapeKey(true, onEscape));

    unmount();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('cleans up event listener when isOpen transitions from true to false', () => {
    const onEscape = vi.fn();

    const { rerender } = renderHook(
      ({ isOpen }) => useEscapeKey(isOpen, onEscape),
      { initialProps: { isOpen: true } },
    );

    rerender({ isOpen: false });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('keeps one stable listener and dispatches to the LATEST callback across identity changes (#2605)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useEscapeKey(true, cb), {
      initialProps: { cb: first },
    });
    const keydownRegistrations = () => addSpy.mock.calls.filter((c) => c[0] === 'keydown').length;
    const afterMount = keydownRegistrations();

    rerender({ cb: second });

    // A re-render with a new callback identity must NOT tear down and re-arm the effect — that
    // churn is what let a per-render side effect steal modal focus on every SSE tick (#2605).
    expect(keydownRegistrations()).toBe(afterMount);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe('defaultPrevented gating', () => {
    it('does not call onEscape when event.defaultPrevented is true', () => {
      const onEscape = vi.fn();
      renderHook(() => useEscapeKey(true, onEscape));

      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      event.preventDefault();
      document.dispatchEvent(event);

      expect(onEscape).not.toHaveBeenCalled();
    });

    it('calls onEscape when event.defaultPrevented is false', () => {
      const onEscape = vi.fn();
      renderHook(() => useEscapeKey(true, onEscape));

      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(event);

      expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('does not call onEscape when Escape has stopImmediatePropagation called by earlier listener', () => {
      const onEscape = vi.fn();
      renderHook(() => useEscapeKey(true, onEscape));

      const earlyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      document.addEventListener('keydown', earlyHandler, { capture: true });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

      expect(onEscape).not.toHaveBeenCalled();

      document.removeEventListener('keydown', earlyHandler, { capture: true });
    });
  });

  describe('topmost-modal arbitration', () => {
    it('closes only the innermost (last-registered) modal on Escape', () => {
      const outer = vi.fn();
      const inner = vi.fn();

      renderHook(() => useEscapeKey(true, outer));
      const innerHook = renderHook(() => useEscapeKey(true, inner));

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(inner).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();

      innerHook.unmount();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(outer).toHaveBeenCalledTimes(1);
      expect(inner).toHaveBeenCalledTimes(1);
    });
  });

});
