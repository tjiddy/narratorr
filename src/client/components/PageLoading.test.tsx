import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageLoading } from './PageLoading';

describe('PageLoading', () => {
  it('renders centered spinner when no header provided', () => {
    render(<PageLoading />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading');
  });

  it('renders header slot above spinner when header ReactNode provided', () => {
    render(<PageLoading header={<h1>Test Header</h1>} />);

    expect(screen.getByText('Test Header')).toBeInTheDocument();
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });
});
