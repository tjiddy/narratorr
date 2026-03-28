import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    const { container } = render(<Modal><div>content</div></Modal>);
    const overlay = container.firstChild as HTMLElement;
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
});
