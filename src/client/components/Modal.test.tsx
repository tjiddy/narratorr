import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '@/components/Modal';

describe('Modal', () => {
  it('renders backdrop with bg-black/80 backdrop-blur-sm and data-testid="modal-backdrop"', () => {
    render(<Modal><div>content</div></Modal>);
    const backdrop = screen.getByTestId('modal-backdrop');
    expect(backdrop).toBeInTheDocument();
    expect(backdrop).toHaveClass('bg-black/80');
    expect(backdrop).toHaveClass('backdrop-blur-sm');
  });

  it('renders fixed overlay with z-50 and animate-fade-in', () => {
    render(<Modal><div>content</div></Modal>);
    // Portal renders to body — find the overlay by its class
    const overlay = screen.getByTestId('modal-backdrop').parentElement!;
    expect(overlay).toHaveClass('fixed');
    expect(overlay).toHaveClass('inset-0');
    expect(overlay).toHaveClass('z-50');
    expect(overlay).toHaveClass('animate-fade-in');
  });

  it('renders children inside the panel with animate-fade-in-up', () => {
    render(<Modal><div data-testid="child">hello</div></Modal>);
    const child = screen.getByTestId('child');
    const panel = child.parentElement!;
    expect(panel).toHaveClass('animate-fade-in-up');
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('calls onClose when backdrop area is clicked and onClose is provided', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Modal onClose={onClose}><div>content</div></Modal>);
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not throw when backdrop is clicked and onClose is not provided', async () => {
    const user = userEvent.setup();
    // Should not throw — WelcomeModal omits onClose intentionally
    expect(() => render(<Modal><div>content</div></Modal>)).not.toThrow();
    await user.click(screen.getByTestId('modal-backdrop'));
    // No assertion on call — just verify no error thrown
  });

  it('does not call onClose when clicking inside the modal panel', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Modal onClose={onClose}><div data-testid="panel-content">inside</div></Modal>);
    await user.click(screen.getByTestId('panel-content'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('scrollable prop applies flex-col and max-h-[85vh] to the panel', () => {
    render(<Modal scrollable><div data-testid="child">content</div></Modal>);
    const child = screen.getByTestId('child');
    const panel = child.parentElement!;
    expect(panel).toHaveClass('flex');
    expect(panel).toHaveClass('flex-col');
    expect(panel).toHaveClass('max-h-[85vh]');
  });

  it('passes className through to the panel wrapper', () => {
    render(<Modal className="max-w-2xl"><div data-testid="child">content</div></Modal>);
    const child = screen.getByTestId('child');
    const panel = child.parentElement!;
    expect(panel).toHaveClass('max-w-2xl');
  });

  describe('portal rendering', () => {
    it('renders modal content into document.body via createPortal', () => {
      const { container } = render(
        <div data-testid="parent-container">
          <Modal><div data-testid="modal-child">hello</div></Modal>
        </div>,
      );
      // Modal should NOT be inside the parent container
      const parent = within(container).getByTestId('parent-container');
      expect(within(parent).queryByTestId('modal-child')).not.toBeInTheDocument();
      // But it should be in the document (rendered to body)
      expect(screen.getByTestId('modal-child')).toBeInTheDocument();
    });
  });

  describe('nested modal stacking', () => {
    it('outer modal remains visible when inner modal opens', () => {
      render(
        <>
          <Modal><div data-testid="outer-content">outer</div></Modal>
          <Modal><div data-testid="inner-content">inner</div></Modal>
        </>,
      );
      expect(screen.getByTestId('outer-content')).toBeInTheDocument();
      expect(screen.getByTestId('inner-content')).toBeInTheDocument();
    });

    it('both modals render separate backdrops', () => {
      render(
        <>
          <Modal><div>outer</div></Modal>
          <Modal><div>inner</div></Modal>
        </>,
      );
      expect(screen.getAllByTestId('modal-backdrop')).toHaveLength(2);
    });

    it('clicking inner backdrop closes only the inner modal, outer onClose NOT called', async () => {
      const outerClose = vi.fn();
      const innerClose = vi.fn();
      const user = userEvent.setup();
      render(
        <>
          <Modal onClose={outerClose}><div>outer</div></Modal>
          <Modal onClose={innerClose}><div>inner</div></Modal>
        </>,
      );
      const backdrops = screen.getAllByTestId('modal-backdrop');
      await user.click(backdrops[1]);
      expect(innerClose).toHaveBeenCalledOnce();
      expect(outerClose).not.toHaveBeenCalled();
    });
  });

  describe('closeOnBackdropClick prop', () => {
    it('does not call onClose when backdrop is clicked and closeOnBackdropClick={false}', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Modal onClose={onClose} closeOnBackdropClick={false}><div>content</div></Modal>);
      await user.click(screen.getByTestId('modal-backdrop'));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('calls onClose when backdrop is clicked and closeOnBackdropClick={true}', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Modal onClose={onClose} closeOnBackdropClick={true}><div>content</div></Modal>);
      await user.click(screen.getByTestId('modal-backdrop'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('calls onClose when backdrop is clicked and closeOnBackdropClick is omitted (default true)', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Modal onClose={onClose}><div>content</div></Modal>);
      await user.click(screen.getByTestId('modal-backdrop'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not call onClose when panel is clicked regardless of closeOnBackdropClick value', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Modal onClose={onClose} closeOnBackdropClick={false}><div data-testid="panel-content">inside</div></Modal>);
      await user.click(screen.getByTestId('panel-content'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('focus trap', () => {
    it('Tab key cycles through focusable elements within an open Modal (does not escape to background)', async () => {
      const user = userEvent.setup();
      render(
        <>
          <button data-testid="outside">outside</button>
          <Modal>
            <button data-testid="first">first</button>
            <button data-testid="second">second</button>
          </Modal>
        </>,
      );
      const first = screen.getByTestId('first');
      const second = screen.getByTestId('second');
      // Focus first button, then Tab — should wrap to second, not escape
      first.focus();
      await user.keyboard('{Tab}');
      expect(document.activeElement).toBe(second);
      // Tab again from last — should wrap to first
      await user.keyboard('{Tab}');
      expect(document.activeElement).toBe(first);
      // Outside button should never receive focus
      expect(document.activeElement).not.toBe(screen.getByTestId('outside'));
    });

    it('Shift+Tab wraps backward to last focusable element within Modal', async () => {
      const user = userEvent.setup();
      render(
        <Modal>
          <button data-testid="first">first</button>
          <button data-testid="second">second</button>
        </Modal>,
      );
      const first = screen.getByTestId('first');
      const second = screen.getByTestId('second');
      first.focus();
      await user.keyboard('{Shift>}{Tab}{/Shift}');
      expect(document.activeElement).toBe(second);
    });

    it('Modal with no focusable children keeps focus on panel container (does not escape)', async () => {
      const user = userEvent.setup();
      render(
        <>
          <button data-testid="outside">outside</button>
          <Modal><p>no focusable content</p></Modal>
        </>,
      );
      // Tab should not move focus to the outside button
      await user.keyboard('{Tab}');
      expect(document.activeElement).not.toBe(screen.getByTestId('outside'));
    });

    it('focus moves into Modal panel when it opens', () => {
      render(<Modal><button>btn</button></Modal>);
      // Panel should have tabIndex={-1} and receive initial focus
      const panel = screen.getByText('btn').parentElement!;
      expect(panel).toHaveAttribute('tabindex', '-1');
      expect(document.activeElement).toBe(panel);
    });

    it('nested modals: inner modal traps focus independently of outer modal', async () => {
      const user = userEvent.setup();
      render(
        <>
          <Modal>
            <button data-testid="outer-btn">outer</button>
            <Modal>
              <button data-testid="inner-a">a</button>
              <button data-testid="inner-b">b</button>
            </Modal>
          </Modal>
        </>,
      );
      const innerA = screen.getByTestId('inner-a');
      const innerB = screen.getByTestId('inner-b');
      innerA.focus();
      await user.keyboard('{Tab}');
      expect(document.activeElement).toBe(innerB);
      // Tab should wrap within inner, not escape to outer
      await user.keyboard('{Tab}');
      expect(document.activeElement).toBe(innerA);
    });
  });
});
