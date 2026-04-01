import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { useFocusTrap } from './useFocusTrap.js';

/** Renders a container with N buttons and wires useFocusTrap */
function Trap({ isOpen, count = 2 }: { isOpen: boolean; count?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(isOpen, ref);
  return (
    <div ref={ref} tabIndex={-1} data-testid="trap">
      {Array.from({ length: count }, (_, i) => (
        <button key={i}>Button {i + 1}</button>
      ))}
    </div>
  );
}

/** Renders a container with one disabled button (zero tabbable elements) */
function TrapEmpty({ isOpen }: { isOpen: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(isOpen, ref);
  return (
    <div ref={ref} tabIndex={-1} data-testid="trap">
      <button disabled>Disabled</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the container on mount (not the first tabbable element)', () => {
    render(<Trap isOpen />);
    expect(document.activeElement).toBe(screen.getByTestId('trap'));
  });

  it('focuses the container when no tabbable elements are present', () => {
    render(<TrapEmpty isOpen />);
    expect(document.activeElement).toBe(screen.getByTestId('trap'));
  });

  it('Tab moves focus to the next tabbable element', async () => {
    const user = userEvent.setup();
    render(<Trap isOpen />);
    screen.getByText('Button 1').focus();
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByText('Button 2'));
  });

  it('Tab on the last tabbable element wraps to the first', async () => {
    const user = userEvent.setup();
    render(<Trap isOpen />);
    screen.getByText('Button 2').focus();
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByText('Button 1'));
  });

  it('Shift+Tab moves focus to the previous tabbable element', async () => {
    const user = userEvent.setup();
    render(<Trap isOpen />);
    screen.getByText('Button 2').focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByText('Button 1'));
  });

  it('Shift+Tab on the first tabbable element wraps to the last', async () => {
    const user = userEvent.setup();
    render(<Trap isOpen />);
    screen.getByText('Button 1').focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByText('Button 2'));
  });

  it('does nothing when isOpen is false', () => {
    render(<Trap isOpen={false} />);
    // focus should not have moved to Button 1
    expect(document.activeElement).not.toBe(screen.getByText('Button 1'));
  });

  it('cleans up event listener on unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Trap isOpen />);
    unmount();
    // After unmount, Tab should not be intercepted — no errors thrown
    await user.keyboard('{Tab}');
  });
});
