import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEscapeKey } from './useEscapeKey';
import { type RefObject } from 'react';

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

  it('focuses focusRef.current when isOpen is true', () => {
    const onEscape = vi.fn();
    const focusEl = { focus: vi.fn() };
    const focusRef = { current: focusEl } as unknown as RefObject<HTMLElement>;

    renderHook(() => useEscapeKey(true, onEscape, focusRef));

    expect(focusEl.focus).toHaveBeenCalledTimes(1);
  });

  describe('defaultPrevented gating', () => {
    it('does not call onEscape when event.defaultPrevented is true', () => {
      const onEscape = vi.fn();
      renderHook(() => useEscapeKey(true, onEscape));

      // Simulate an Escape event where another handler already called preventDefault
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

      // Register a higher-priority listener that stops immediate propagation
      const earlyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      document.addEventListener('keydown', earlyHandler, { capture: true });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

      // The hook listener never fires because stopImmediatePropagation was called
      expect(onEscape).not.toHaveBeenCalled();

      document.removeEventListener('keydown', earlyHandler, { capture: true });
    });
  });

  it('does not throw when focusRef is undefined', () => {
    const onEscape = vi.fn();

    expect(() => {
      renderHook(() => useEscapeKey(true, onEscape, undefined));
    }).not.toThrow();
  });
});
