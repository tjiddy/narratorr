import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { DiscoverEmpty } from './DiscoverEmpty';

describe('DiscoverEmpty', () => {
  it('no-library variant renders Find Books action link', () => {
    renderWithProviders(<DiscoverEmpty variant="no-library" />);
    const link = screen.getByText('Find Books').closest('a');
    expect(link).toHaveAttribute('href', '/search');
  });

  it('no-suggestions variant renders without action links', () => {
    renderWithProviders(<DiscoverEmpty variant="no-suggestions" />);
    expect(screen.queryByText('Find Books')).not.toBeInTheDocument();
  });

  it('no-library variant has no local CTA wrapper div', () => {
    const { container } = renderWithProviders(<DiscoverEmpty variant="no-library" />);
    const emptyStateRoot = container.querySelector('[data-testid="discover-empty"]');
    const actionRow = emptyStateRoot?.querySelector(':scope > .flex.flex-wrap.items-center.gap-3');
    expect(actionRow).toBeInTheDocument();
    const nestedWrapper = actionRow?.querySelector(':scope > .flex.flex-wrap.items-center.gap-3');
    expect(nestedWrapper).not.toBeInTheDocument();
  });
});
