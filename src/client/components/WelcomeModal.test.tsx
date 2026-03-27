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
});
