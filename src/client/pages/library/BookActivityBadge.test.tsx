import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BookActivityBadge } from './BookActivityBadge.js';

describe('BookActivityBadge', () => {
  it('renders nothing when activity is null', () => {
    const { container } = render(<BookActivityBadge activity={null} variant="chip" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('chip: working shows a spinner with the label and rounded percentage', () => {
    render(<BookActivityBadge activity={{ state: 'working', label: 'Encoding…', percentage: 60.4 }} variant="chip" />);
    const chip = screen.getByTestId('activity-chip');
    expect(chip).toHaveAccessibleName('Encoding — 60%');
    expect(chip.querySelector('[data-testid="loading-spinner"]')).toBeInTheDocument();
  });

  it('chip: queued shows the hourglass and no spinner', () => {
    render(<BookActivityBadge activity={{ state: 'queued', label: 'Merge queued' }} variant="chip" />);
    const chip = screen.getByTestId('activity-chip');
    expect(chip).toHaveAccessibleName('Merge queued');
    expect(chip.querySelector('[data-testid="loading-spinner"]')).not.toBeInTheDocument();
    expect(chip.querySelector('svg')).toBeInTheDocument();
  });

  it('inline: shows label text with percentage appended', () => {
    render(<BookActivityBadge activity={{ state: 'working', label: 'Encoding…', percentage: 79 }} variant="inline" />);
    expect(screen.getByTestId('activity-inline')).toHaveTextContent('Encoding… 79%');
  });

  it('inline: queued shows label without percentage', () => {
    render(<BookActivityBadge activity={{ state: 'queued', label: 'Import queued' }} variant="inline" />);
    expect(screen.getByTestId('activity-inline')).toHaveTextContent('Import queued');
    expect(screen.getByTestId('activity-inline').textContent).not.toMatch(/%/);
  });
});
