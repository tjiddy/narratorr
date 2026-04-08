import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ReleaseCard } from './ReleaseCard';
import type { SearchResult } from '@/lib/api';

vi.mock('@core/utils/index.js', () => ({
  calculateQuality: vi.fn(),
  compareQuality: vi.fn(),
  qualityTierBg: vi.fn(() => 'bg-green-500/10 text-green-400'),
}));

const { calculateQuality } = await import('@core/utils/index.js');
const mockCalculateQuality = calculateQuality as ReturnType<typeof vi.fn>;

const baseResult: SearchResult = {
  title: 'Test Book',
  rawTitle: 'Test.Book.2024',
  indexer: 'TestIndexer',
  downloadUrl: 'https://example.com/dl',
  guid: 'guid-1',
  size: 500_000_000,
  protocol: 'torrent',
  seeders: 10,
  author: 'Author',
  narrator: 'Narrator',
  coverUrl: undefined,
};

const defaultProps = {
  result: baseResult,
  onGrab: vi.fn(),
  onBlacklist: vi.fn(),
  isGrabbing: false,
  isBlacklisting: false,
};

describe('ReleaseCard', () => {
  describe('#324 — quality badge when duration unknown (verify only)', () => {
    it('when bookDurationSeconds is undefined, no quality badge rendered', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} bookDurationSeconds={undefined} />);
      expect(screen.queryByText(/MB\/hr/)).not.toBeInTheDocument();
    });

    it('when bookDurationSeconds is 0, no quality badge rendered', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} bookDurationSeconds={0} />);
      expect(screen.queryByText(/MB\/hr/)).not.toBeInTheDocument();
    });

    it('when bookDurationSeconds is valid and result.size > 0, quality badge renders with tier and MB/hr', () => {
      mockCalculateQuality.mockReturnValue({ tier: 'Good', mbPerHour: 64 });
      renderWithProviders(<ReleaseCard {...defaultProps} bookDurationSeconds={36000} />);
      expect(screen.getByText(/Good · 64 MB\/hr/)).toBeInTheDocument();
    });
  });

  describe('#317 — freeleech/VIP badges', () => {
    it('renders Freeleech badge when result.isFreeleech is true', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} result={{ ...baseResult, isFreeleech: true }} />);
      expect(screen.getByText('Freeleech')).toBeInTheDocument();
    });

    it('renders VIP badge when result.isVipOnly is true', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} result={{ ...baseResult, isVipOnly: true }} />);
      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('renders both badges when both flags are true', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} result={{ ...baseResult, isFreeleech: true, isVipOnly: true }} />);
      expect(screen.getByText('Freeleech')).toBeInTheDocument();
      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('does not render badges when flags are undefined', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} />);
      expect(screen.queryByText('Freeleech')).not.toBeInTheDocument();
      expect(screen.queryByText('VIP')).not.toBeInTheDocument();
    });
  });

  describe('language pill', () => {
    it('shows language pill when result has language metadata', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, language: 'English' }}
        />,
      );
      expect(screen.getByText('english')).toBeInTheDocument();
    });

    it('hides pill when result has no language metadata', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult }}
        />,
      );
      expect(screen.queryByText('english')).not.toBeInTheDocument();
    });

    it('pill text matches normalized language name', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, language: 'FRENCH' }}
        />,
      );
      // result.language.toLowerCase() = 'french', rendered with capitalize CSS
      expect(screen.getByText('french')).toBeInTheDocument();
    });
  });

  describe('#421 — "In library" badge', () => {
    const IN_LIBRARY = 'In library';

    // Positive matching
    it('renders "In library" badge when result.guid matches lastGrabGuid (usenet path)', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard {...defaultProps} result={{ ...baseResult, guid: 'usenet-guid-1' }} lastGrabGuid="usenet-guid-1" />,
      );
      expect(screen.getByText(IN_LIBRARY)).toBeInTheDocument();
    });

    it('renders "In library" badge when result.infoHash matches lastGrabInfoHash (torrent path)', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard {...defaultProps} result={{ ...baseResult, infoHash: 'hash-abc' }} lastGrabInfoHash="hash-abc" />,
      );
      expect(screen.getByText(IN_LIBRARY)).toBeInTheDocument();
    });

    it('renders "In library" badge when both guid AND infoHash match simultaneously', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: 'g1', infoHash: 'h1' }}
          lastGrabGuid="g1"
          lastGrabInfoHash="h1"
        />,
      );
      expect(screen.getByText(IN_LIBRARY)).toBeInTheDocument();
    });

    // Negative / no-match cases
    it('no badge when lastGrabGuid and lastGrabInfoHash are both null', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard {...defaultProps} lastGrabGuid={null} lastGrabInfoHash={null} />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('no badge when identifiers exist on book but do not match result', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: 'result-guid', infoHash: 'result-hash' }}
          lastGrabGuid="different-guid"
          lastGrabInfoHash="different-hash"
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('no badge when both identifiers on result are undefined', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: undefined, infoHash: undefined }}
          lastGrabGuid="some-guid"
          lastGrabInfoHash="some-hash"
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    // Null safety and falsy edge cases
    it('null guid on result does NOT match null lastGrabGuid (null ≠ null)', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: undefined, infoHash: undefined }}
          lastGrabGuid={null}
          lastGrabInfoHash={null}
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('empty string guid does NOT match a populated lastGrabGuid', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: '' }}
          lastGrabGuid="real-guid"
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('undefined infoHash on result does NOT match null lastGrabInfoHash', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, infoHash: undefined }}
          lastGrabInfoHash={null}
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('only one identifier populated on book, only the other on result → no match', () => {
      mockCalculateQuality.mockReturnValue(null);
      // Book has guid, result only has infoHash (no guid)
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: undefined, infoHash: 'hash-xyz' }}
          lastGrabGuid="some-guid"
          lastGrabInfoHash={null}
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    // Conditional rendering
    it('badge renders independently of quality comparison (no existingBookSizeBytes)', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: 'match-guid' }}
          lastGrabGuid="match-guid"
          existingBookSizeBytes={undefined}
        />,
      );
      expect(screen.getByText(IN_LIBRARY)).toBeInTheDocument();
    });

    it('badge coexists with freeleech, VIP, language, and quality badges', () => {
      mockCalculateQuality.mockReturnValue({ tier: 'Good', mbPerHour: 64 });
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: 'match-guid', isFreeleech: true, isVipOnly: true, language: 'English' }}
          lastGrabGuid="match-guid"
          bookDurationSeconds={36000}
        />,
      );
      expect(screen.getByText(IN_LIBRARY)).toBeInTheDocument();
      expect(screen.getByText('Freeleech')).toBeInTheDocument();
      expect(screen.getByText('VIP')).toBeInTheDocument();
      expect(screen.getByText('english')).toBeInTheDocument();
      expect(screen.getByText(/Good · 64 MB\/hr/)).toBeInTheDocument();
    });
  });
});
