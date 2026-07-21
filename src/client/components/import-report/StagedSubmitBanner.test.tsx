import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StagedSubmitBanner } from './StagedSubmitBanner';

/**
 * Interactive coverage for the staged-submit status banner (#1902 F17). The hook tests
 * only observe the `banner` string in hook state — nothing renders this component — so
 * without a component test, deleting the button wiring or the null-guard would still
 * pass the suite.
 */
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
