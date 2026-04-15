import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingSpinner } from './icons';

describe('LoadingSpinner', () => {
  it('renders with role="status" and accessible name when label prop is provided', () => {
    render(<LoadingSpinner label="Loading" />);

    const spinner = screen.getByRole('status');
    expect(spinner).toHaveAccessibleName('Loading');
    expect(spinner).toHaveAttribute('aria-live', 'polite');
  });

  it('renders with aria-hidden="true" and no role when label is omitted', () => {
    render(<LoadingSpinner />);

    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).not.toHaveAttribute('role');
  });
});
