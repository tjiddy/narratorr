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
});
