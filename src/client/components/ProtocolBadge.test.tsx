import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProtocolBadge } from '@/components/ProtocolBadge';

describe('ProtocolBadge', () => {
  it('renders "Torrent" for torrent protocol with emerald styling', () => {
    render(<ProtocolBadge protocol="torrent" />);
    const badge = screen.getByTestId('protocol-badge');
    expect(badge).toHaveTextContent('Torrent');
    expect(badge).toHaveClass('bg-emerald-500/10', 'text-emerald-600');
  });

  it('renders "Usenet" for usenet protocol with violet styling', () => {
    render(<ProtocolBadge protocol="usenet" />);
    const badge = screen.getByTestId('protocol-badge');
    expect(badge).toHaveTextContent('Usenet');
    expect(badge).toHaveClass('bg-violet-500/10', 'text-violet-600');
  });
});
