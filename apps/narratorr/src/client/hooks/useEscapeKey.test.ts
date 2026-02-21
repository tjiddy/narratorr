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

  it('does not throw when focusRef is undefined', () => {
    const onEscape = vi.fn();

    expect(() => {
      renderHook(() => useEscapeKey(true, onEscape, undefined));
    }).not.toThrow();
  });
});
