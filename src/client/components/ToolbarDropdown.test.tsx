import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { ToolbarDropdown } from './ToolbarDropdown';

function Wrapper({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} data-testid="trigger">trigger</button>
      <ToolbarDropdown triggerRef={ref} open={open} onClose={onClose}>
        <div data-testid="panel">panel content</div>
      </ToolbarDropdown>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ToolbarDropdown', () => {
  it('renders children into document.body portal when open is true', () => {
    render(<Wrapper open={true} onClose={vi.fn()} />);
    // Portal renders into document.body — screen queries search body by default
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    // The panel should be a direct child of document.body (portal)
    expect(document.body.querySelector('[data-testid="panel"]')).toBeInTheDocument();
  });

  it('does not render panel when open is false', () => {
    render(<Wrapper open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('calls onClose when clicking outside the trigger and panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div>
        <Wrapper open={true} onClose={onClose} />
        <button data-testid="outside">outside element</button>
      </div>,
    );

    await user.click(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when clicking inside the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Wrapper open={true} onClose={onClose} />);

    await user.click(screen.getByTestId('panel'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call onClose when clicking the trigger', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Wrapper open={true} onClose={onClose} />);

    await user.click(screen.getByTestId('trigger'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed while open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Wrapper open={true} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose on Escape when closed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Wrapper open={false} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('positioning', () => {
    it('positions the portal panel at top/left derived from trigger getBoundingClientRect on open', () => {
      const onClose = vi.fn();
      const { rerender, getByTestId } = render(<Wrapper open={false} onClose={onClose} />);

      const trigger = getByTestId('trigger');
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        bottom: 100, left: 50, top: 80, right: 150, width: 100, height: 20,
        x: 50, y: 80, toJSON: () => ({}),
      } as DOMRect);

      rerender(<Wrapper open={true} onClose={onClose} />);

      // panel is portaled to body; its wrapper div carries the computed position
      const portalWrapper = getByTestId('panel').parentElement!;
      // top = rect.bottom + window.scrollY + 4 = 100 + 0 + 4 = 104
      // left = rect.left + window.scrollX     = 50  + 0     = 50
      expect(portalWrapper).toHaveStyle({ top: '104px', left: '50px' });
    });

    it('recomputes panel position on window scroll', async () => {
      const onClose = vi.fn();
      const { rerender, getByTestId } = render(<Wrapper open={false} onClose={onClose} />);

      const trigger = getByTestId('trigger');
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        bottom: 100, left: 50, top: 80, right: 150, width: 100, height: 20,
        x: 50, y: 80, toJSON: () => ({}),
      } as DOMRect);

      rerender(<Wrapper open={true} onClose={onClose} />);

      // Simulate the trigger moving after a scroll (different bottom position)
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        bottom: 140, left: 50, top: 120, right: 150, width: 100, height: 20,
        x: 50, y: 120, toJSON: () => ({}),
      } as DOMRect);

      await act(async () => {
        window.dispatchEvent(new Event('scroll', { bubbles: true }));
      });

      const portalWrapper = getByTestId('panel').parentElement!;
      // top = 140 + 0 + 4 = 144
      expect(portalWrapper).toHaveStyle({ top: '144px', left: '50px' });
    });

    it('recomputes panel position on window resize', async () => {
      const onClose = vi.fn();
      const { rerender, getByTestId } = render(<Wrapper open={false} onClose={onClose} />);

      const trigger = getByTestId('trigger');
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        bottom: 100, left: 50, top: 80, right: 150, width: 100, height: 20,
        x: 50, y: 80, toJSON: () => ({}),
      } as DOMRect);

      rerender(<Wrapper open={true} onClose={onClose} />);

      // Simulate the trigger moving after a resize (different left position)
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        bottom: 100, left: 80, top: 80, right: 180, width: 100, height: 20,
        x: 80, y: 80, toJSON: () => ({}),
      } as DOMRect);

      await act(async () => {
        window.dispatchEvent(new Event('resize'));
      });

      const portalWrapper = getByTestId('panel').parentElement!;
      // left = 80 + 0 = 80
      expect(portalWrapper).toHaveStyle({ top: '104px', left: '80px' });
    });
  });
});
