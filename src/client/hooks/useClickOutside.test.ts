import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useClickOutside } from './useClickOutside';
import { type RefObject } from 'react';

function createRef(el: Element | null = null): RefObject<Element | null> {
  return { current: el };
}

describe('useClickOutside', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('single ref', () => {
    it('calls handler on mousedown outside the ref element', () => {
      const handler = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      renderHook(() => useClickOutside(ref, handler));

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).toHaveBeenCalledTimes(1);
      document.body.removeChild(el);
    });

    it('does NOT call handler on mousedown inside the ref element', () => {
      const handler = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      renderHook(() => useClickOutside(ref, handler));

      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });

    it('no-ops when ref.current is null (unmounted component)', () => {
      const handler = vi.fn();
      const ref = createRef(null);

      renderHook(() => useClickOutside(ref, handler));

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('multi-ref', () => {
    it('does NOT call handler when clicking inside any of the provided refs', () => {
      const handler = vi.fn();
      const trigger = document.createElement('button');
      const panel = document.createElement('div');
      document.body.appendChild(trigger);
      document.body.appendChild(panel);
      const triggerRef = createRef(trigger);
      const panelRef = createRef(panel);

      renderHook(() => useClickOutside([triggerRef, panelRef], handler));

      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(handler).not.toHaveBeenCalled();

      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(handler).not.toHaveBeenCalled();

      document.body.removeChild(trigger);
      document.body.removeChild(panel);
    });

    it('calls handler when clicking outside all provided refs', () => {
      const handler = vi.fn();
      const trigger = document.createElement('button');
      const panel = document.createElement('div');
      document.body.appendChild(trigger);
      document.body.appendChild(panel);
      const triggerRef = createRef(trigger);
      const panelRef = createRef(panel);

      renderHook(() => useClickOutside([triggerRef, panelRef], handler));

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).toHaveBeenCalledTimes(1);

      document.body.removeChild(trigger);
      document.body.removeChild(panel);
    });
  });

  describe('enabled flag', () => {
    it('does not fire handler when enabled is false', () => {
      const handler = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      renderHook(() => useClickOutside(ref, handler, false));

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });

    it('re-registers listener when enabled transitions from false to true', () => {
      const handler = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      const { rerender } = renderHook(
        ({ enabled }) => useClickOutside(ref, handler, enabled),
        { initialProps: { enabled: false } },
      );

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(handler).not.toHaveBeenCalled();

      rerender({ enabled: true });

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(handler).toHaveBeenCalledTimes(1);

      document.body.removeChild(el);
    });
  });

  describe('lifecycle', () => {
    it('cleans up listener on unmount', () => {
      const handler = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      const { unmount } = renderHook(() => useClickOutside(ref, handler));

      unmount();

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });

    it('cleans up and re-attaches listener when handler identity changes', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      const { rerender } = renderHook(
        ({ handler }) => useClickOutside(ref, handler),
        { initialProps: { handler: handler1 } },
      );

      rerender({ handler: handler2 });

      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);

      document.body.removeChild(el);
    });
  });

  describe('event specificity', () => {
    it('mousedown triggers handler; click alone does not', () => {
      const handler = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const ref = createRef(el);

      renderHook(() => useClickOutside(ref, handler));

      // click should NOT trigger
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(handler).not.toHaveBeenCalled();

      // mousedown SHOULD trigger
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(handler).toHaveBeenCalledTimes(1);

      document.body.removeChild(el);
    });
  });
});
