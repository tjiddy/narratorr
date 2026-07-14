import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTip } from './InfoTip';

describe('InfoTip', () => {
  it('hides the tooltip content by default', () => {
    render(<InfoTip>Extra detail here</InfoTip>);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.queryByText('Extra detail here')).not.toBeInTheDocument();
  });

  it('toggles via keyboard activation with no hover involved (touch/keyboard path)', async () => {
    // Enter on the focused trigger exercises the PIN state alone — a mouse click always
    // carries a mouseenter with it, so this is the only way to test the toggle in isolation.
    const user = userEvent.setup();
    render(<InfoTip label="Script environment variables">Extra detail here</InfoTip>);
    const trigger = screen.getByRole('button', { name: 'Script environment variables' });

    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Extra detail here');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on hover and closes on mouse leave', async () => {
    const user = userEvent.setup();
    render(<InfoTip>Extra detail here</InfoTip>);
    const trigger = screen.getByRole('button', { name: 'More info' });

    await user.hover(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.unhover(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes on click outside', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">elsewhere</button>
        <InfoTip>Extra detail here</InfoTip>
      </div>
    );
    await user.click(screen.getByRole('button', { name: 'More info' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<InfoTip>Extra detail here</InfoTip>);
    const trigger = screen.getByRole('button', { name: 'More info' });

    await user.click(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('renders rich children inside the tooltip', async () => {
    const user = userEvent.setup();
    render(
      <InfoTip>
        <code>NARRATORR_BOOK_TITLE</code>
      </InfoTip>
    );
    await user.click(screen.getByRole('button', { name: 'More info' }));
    expect(screen.getByRole('tooltip').querySelector('code')).toHaveTextContent('NARRATORR_BOOK_TITLE');
  });
});
