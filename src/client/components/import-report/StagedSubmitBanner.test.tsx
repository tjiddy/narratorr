import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StagedSubmitBanner } from './StagedSubmitBanner';

describe('StagedSubmitBanner (#1902)', () => {
  it('renders nothing when the message is null', () => {
    const { container } = render(<StagedSubmitBanner message={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the pinned status surface when a message is present', () => {
    render(<StagedSubmitBanner message="Couldn’t reach the server — reload to retry" onDismiss={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Couldn’t reach the server — reload to retry');
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('invokes onDismiss when the Dismiss button is clicked', async () => {
    const onDismiss = vi.fn();
    render(<StagedSubmitBanner message="Import finished, but its results couldn’t be loaded — reopen to try again" onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
