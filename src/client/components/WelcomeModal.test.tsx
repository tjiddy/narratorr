import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WelcomeModal } from './WelcomeModal';

describe('WelcomeModal', () => {
  const onDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true — shows title, all row sections, footer text, and Get Started button', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Welcome to narratorr')).toBeInTheDocument();
    expect(screen.getByText('Read This First')).toBeInTheDocument();
    expect(screen.getByText('First Steps')).toBeInTheDocument();
    expect(screen.getByText('Features Worth Knowing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument();
    expect(screen.getByText('You can view this again anytime in Settings')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<WelcomeModal isOpen={false} onDismiss={onDismiss} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Get Started" button calls onDismiss when clicked', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('Get Started button is disabled while isPending is true', () => {
    render(<WelcomeModal isOpen isPending onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
  });

  it('Get Started button shows "Saving..." text while isPending', () => {
    render(<WelcomeModal isOpen isPending onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /saving/i })).toHaveTextContent('Saving...');
  });

  it('Row 1 cards each have a warning badge', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    // 3 warning badges for the 3 "Read This" cards
    const badges = screen.getAllByLabelText('Important');
    expect(badges).toHaveLength(3);
  });

  it('footer text "You can view this again anytime in Settings" is present', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByText('You can view this again anytime in Settings')).toBeInTheDocument();
  });

  it('Get Started button has type="button" to prevent accidental form submission', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /get started/i })).toHaveAttribute('type', 'button');
  });

  it('pressing Escape does NOT close the modal (onboarding requires explicit Get Started)', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);

    await user.keyboard('{Escape}');

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Scroll lock (AC1)
  it('sets document.body overflow to hidden while modal is open', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores document.body overflow to its original value on close/unmount', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = ''; // cleanup
  });

  // Focus trap (AC2)
  it('places focus on the first tabbable element when modal opens', () => {
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /get started/i }));
  });

  it('places focus on modal container when isPending=true disables the only tabbable element', () => {
    render(<WelcomeModal isOpen isPending onDismiss={onDismiss} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('Tab key cycles forward through tabbable elements and wraps around', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    // Only one tabbable element: Tab wraps back to it
    const button = screen.getByRole('button', { name: /get started/i });
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(button);
  });

  it('Shift+Tab key cycles backward through tabbable elements and wraps around', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    const button = screen.getByRole('button', { name: /get started/i });
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(button);
  });

  it('Tab key does not move focus outside the modal', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    await user.keyboard('{Tab}');
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // Backdrop non-dismiss (AC — clicking outside does not close the modal)
  it('clicking the backdrop does not dismiss the modal', async () => {
    const user = userEvent.setup();
    render(<WelcomeModal isOpen onDismiss={onDismiss} />);
    // Click the outermost container (backdrop area) outside the dialog panel
    const container = screen.getByRole('presentation');
    await user.click(container);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
