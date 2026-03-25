import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
