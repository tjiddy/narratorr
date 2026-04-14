import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '@/components/PageHeader';

describe('PageHeader', () => {
  it('renders title text', () => {
    render(<PageHeader title="Activity" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<PageHeader title="Activity" subtitle="Monitor your downloads" />);
    expect(screen.getByText('Monitor your downloads')).toBeInTheDocument();
  });

  it('does not render subtitle element when omitted', () => {
    const { container } = render(<PageHeader title="Activity" />);
    expect(container.querySelector('p')).not.toBeInTheDocument();
  });

  it('renders with correct h1 typography classes', () => {
    render(<PageHeader title="Activity" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveClass('font-display', 'text-3xl', 'font-bold', 'tracking-tight');
  });

  it('renders with animate-fade-in-up class on wrapper', () => {
    const { container } = render(<PageHeader title="Activity" />);
    expect(container.firstChild).toHaveClass('animate-fade-in-up');
  });

  it('renders empty string title without error', () => {
    render(<PageHeader title="" />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
