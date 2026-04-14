import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmModal } from '@/components/ConfirmModal';

describe('ConfirmModal', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Delete Item',
    message: 'Are you sure you want to delete this?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders when open', () => {
    render(<ConfirmModal {...defaultProps} />);

    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this?')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    const { container } = render(<ConfirmModal {...defaultProps} isOpen={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows default button labels', () => {
    render(<ConfirmModal {...defaultProps} />);

    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows custom button labels', () => {
    render(
      <ConfirmModal
        {...defaultProps}
        confirmLabel="Yes, remove"
        cancelLabel="No, keep"
      />,
    );

    expect(screen.getByText('Yes, remove')).toBeInTheDocument();
    expect(screen.getByText('No, keep')).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...defaultProps} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByText('Delete'));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when cancel button is clicked', async () => {
    const onCancel = vi.fn();
    render(<ConfirmModal {...defaultProps} onCancel={onCancel} />);

    await userEvent.click(screen.getByText('Cancel'));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('buttons have explicit type="button" attribute', () => {
    render(<ConfirmModal {...defaultProps} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    buttons.forEach((btn) => expect(btn).toHaveAttribute('type', 'button'));
  });

  it('clicking Cancel inside a form does not trigger form onSubmit', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ConfirmModal {...defaultProps} />
      </form>,
    );

    await userEvent.click(screen.getByText('Cancel'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clicking Confirm inside a form does not trigger form onSubmit', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ConfirmModal {...defaultProps} />
      </form>,
    );

    await userEvent.click(screen.getByText('Delete'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('confirm button uses destructive variant styling; cancel button does not', () => {
    render(<ConfirmModal {...defaultProps} />);
    const confirmBtn = screen.getByText('Delete').closest('button')!;
    const cancelBtn = screen.getByText('Cancel').closest('button')!;
    expect(confirmBtn).toHaveClass('bg-destructive', 'text-destructive-foreground');
    expect(cancelBtn).not.toHaveClass('bg-destructive');
  });

  it('calls onCancel when the backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Escape is pressed', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmModal {...defaultProps} onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not call onCancel when Escape is pressed while closed', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmModal {...defaultProps} isOpen={false} onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  describe('focus trap coexistence with base Modal (#551)', () => {
    it('initial focus lands on inner dialog wrapper (useEscapeKey autofocus overrides base Modal trap)', () => {
      render(<ConfirmModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(document.activeElement).toBe(dialog);
    });

    it('Tab cycles through Cancel and Delete buttons within the modal', async () => {
      const user = userEvent.setup();
      render(<ConfirmModal {...defaultProps} />);
      const cancelBtn = screen.getByText('Cancel').closest('button')!;
      const deleteBtn = screen.getByText('Delete').closest('button')!;
      // Focus the first button
      cancelBtn.focus();
      expect(document.activeElement).toBe(cancelBtn);
      // Tab to second button
      await user.keyboard('{Tab}');
      expect(document.activeElement).toBe(deleteBtn);
      // Tab wraps back to first
      await user.keyboard('{Tab}');
      expect(document.activeElement).toBe(cancelBtn);
    });
  });

  describe('ARIA compliance (#484)', () => {
    it('has role="dialog", aria-modal="true", tabIndex={-1}, and aria-labelledby on the dialog element', () => {
      render(<ConfirmModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('tabIndex', '-1');
      expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-modal-title');
      const heading = document.getElementById('confirm-modal-title');
      expect(heading).toBeInTheDocument();
    });
  });
});
