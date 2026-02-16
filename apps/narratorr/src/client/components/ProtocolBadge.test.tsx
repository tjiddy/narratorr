import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProtocolBadge } from '@/components/ProtocolBadge';

describe('ProtocolBadge', () => {
  it('renders "Torrent" for torrent protocol', () => {
    render(<ProtocolBadge protocol="torrent" />);
    const badge = screen.getByTestId('protocol-badge');
    expect(badge).toHaveTextContent('Torrent');
    expect(badge.className).toContain('emerald');
  });

  it('renders "Usenet" for usenet protocol', () => {
    render(<ProtocolBadge protocol="usenet" />);
    const badge = screen.getByTestId('protocol-badge');
    expect(badge).toHaveTextContent('Usenet');
    expect(badge.className).toContain('violet');
  });
});
