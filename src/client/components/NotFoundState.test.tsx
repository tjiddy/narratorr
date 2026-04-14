import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotFoundState } from '@/components/NotFoundState';
import { BookOpenIcon } from '@/components/icons';

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('NotFoundState', () => {
  it('renders heading text', () => {
    renderWithRouter(
      <NotFoundState icon={BookOpenIcon} title="Author not found" subtitle="Not here" backTo="/library" backLabel="Back to Library" />
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Author not found' })).toBeInTheDocument();
  });

  it('renders subtitle text', () => {
    renderWithRouter(
      <NotFoundState icon={BookOpenIcon} title="Book not found" subtitle="The book doesn't exist" backTo="/library" backLabel="Back to Library" />
    );
    expect(screen.getByText("The book doesn't exist")).toBeInTheDocument();
  });

  it('renders icon', () => {
    renderWithRouter(
      <NotFoundState icon={BookOpenIcon} title="Not found" subtitle="Gone" backTo="/library" backLabel="Back" />
    );
    // BookOpenIcon renders an svg
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.closest('div')?.parentElement?.querySelector('svg')).toBeInTheDocument();
  });

  it('renders back link with correct href', () => {
    renderWithRouter(
      <NotFoundState icon={BookOpenIcon} title="Not found" subtitle="Gone" backTo="/library" backLabel="Back to Library" />
    );
    const link = screen.getByRole('link', { name: /back to library/i });
    expect(link).toHaveAttribute('href', '/library');
  });

  it('renders back link with correct text', () => {
    renderWithRouter(
      <NotFoundState icon={BookOpenIcon} title="Not found" subtitle="Gone" backTo="/library" backLabel="Back to Library" />
    );
    expect(screen.getByRole('link', { name: /back to library/i })).toBeInTheDocument();
  });
});
