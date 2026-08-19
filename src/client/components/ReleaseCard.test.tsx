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
      renderWithProviders(<ReleaseCard {...defaultProps} />);
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

    it('renders the container format verbatim, with no label prefix', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} result={{ ...baseResult, format: 'm4b' }} />);
      expect(screen.getByText('m4b')).toBeInTheDocument();
      expect(screen.queryByText(/filetype/i)).not.toBeInTheDocument();
    });

    it('renders no format badge when the indexer supplied none (Torznab/Newznab)', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} result={baseResult} />);
      expect(screen.queryByText('m4b')).not.toBeInTheDocument();
      expect(screen.queryByText('mp3')).not.toBeInTheDocument();
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
      // capitalize CSS changes rendering; result.language.toLowerCase() remains the DOM text.
      expect(screen.getByText('french')).toBeInTheDocument();
    });
  });

  describe('#421 — "In library" badge', () => {
    const IN_LIBRARY = 'In library';

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
      const { guid: _guid, infoHash: _infoHash, ...resultNoIds } = baseResult;
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={resultNoIds}
          lastGrabGuid="some-guid"
          lastGrabInfoHash="some-hash"
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('null guid on result does NOT match null lastGrabGuid (null ≠ null)', () => {
      mockCalculateQuality.mockReturnValue(null);
      const { guid: _guid, infoHash: _infoHash, ...resultNoIds } = baseResult;
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={resultNoIds}
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
          result={baseResult}
          lastGrabInfoHash={null}
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('only one identifier populated on book, only the other on result → no match', () => {
      mockCalculateQuality.mockReturnValue(null);
      const { guid: _guid, ...resultNoGuid } = baseResult;
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...resultNoGuid, infoHash: 'hash-xyz' }}
          lastGrabGuid="some-guid"
          lastGrabInfoHash={null}
        />,
      );
      expect(screen.queryByText(IN_LIBRARY)).not.toBeInTheDocument();
    });

    it('badge renders independently of quality comparison (no existingBookSizeBytes)', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard
          {...defaultProps}
          result={{ ...baseResult, guid: 'match-guid' }}
          lastGrabGuid="match-guid"
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
  describe('headline composition — title leads the truncated line', () => {
    it('renders the title before the author roll, so truncation eats the authors', () => {
      mockCalculateQuality.mockReturnValue(null);
      const anthology = {
        ...baseResult,
        title: 'Folk & Fairy Tales of Azeroth',
        author: 'Christie Golden, Garth Nix, Madeleine Roux, Catherynne M Valente, Steve Danuser, Molly Knox Ostertag, Avalon Irons',
      };
      renderWithProviders(<ReleaseCard {...defaultProps} result={anthology} />);

      const heading = screen.getByRole('heading', { level: 4 });
      expect(heading.textContent).toBe('Folk & Fairy Tales of Azeroth — Christie Golden, Garth Nix, Madeleine Roux, Catherynne M Valente, Steve Danuser, Molly Knox Ostertag, Avalon Irons');
    });

    it('renders the bare title when the result carries no author', () => {
      mockCalculateQuality.mockReturnValue(null);
      const { author: _author, ...rest } = baseResult;
      renderWithProviders(<ReleaseCard {...defaultProps} result={rest} />);
      expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('Test Book');
    });
  });

  describe('#2322 — Grab control at the unsatisfied limit', () => {
    const AT_LIMIT_TEXT = /cannot take it right now/i;
    const grabButton = () => screen.getByRole('button', { name: /Grab/ });
    const { downloadUrl: _url, ...linkless } = baseResult;

    /** Every reachable combination of the three inputs that drive the control. */
    const rows: Array<{
      name: string;
      result: SearchResult;
      isGrabbing: boolean;
      disabled: boolean;
      showsAtLimit: boolean;
    }> = [
      {
        name: 'no link, at the limit — the permanent no-link state outranks the temporary one',
        result: { ...linkless, unsatisfied: { count: 150, limit: 150 } },
        isGrabbing: false, disabled: true, showsAtLimit: false,
      },
      {
        name: 'no link, below the limit',
        result: { ...linkless, unsatisfied: { count: 1, limit: 150 } },
        isGrabbing: false, disabled: true, showsAtLimit: false,
      },
      {
        name: 'no link, in flight',
        result: linkless as SearchResult,
        isGrabbing: true, disabled: true, showsAtLimit: false,
      },
      {
        name: 'linked, at the limit',
        result: { ...baseResult, unsatisfied: { count: 150, limit: 150 } },
        isGrabbing: false, disabled: true, showsAtLimit: true,
      },
      {
        name: 'linked, at the limit, in flight',
        result: { ...baseResult, unsatisfied: { count: 151, limit: 150 } },
        isGrabbing: true, disabled: true, showsAtLimit: true,
      },
      {
        name: 'linked, below the limit',
        result: { ...baseResult, unsatisfied: { count: 149, limit: 150 } },
        isGrabbing: false, disabled: false, showsAtLimit: false,
      },
      {
        name: 'linked, carrying nothing',
        result: baseResult,
        isGrabbing: false, disabled: false, showsAtLimit: false,
      },
      {
        name: 'linked, carrying nothing, in flight',
        result: baseResult,
        isGrabbing: true, disabled: true, showsAtLimit: false,
      },
    ];

    for (const row of rows) {
      it(`${row.name} → ${row.disabled ? 'disabled' : 'enabled'}, at-limit reason ${row.showsAtLimit ? 'shown' : 'absent'}`, () => {
        mockCalculateQuality.mockReturnValue(null);
        renderWithProviders(<ReleaseCard {...defaultProps} result={row.result} isGrabbing={row.isGrabbing} />);

        expect(grabButton()).toHaveProperty('disabled', row.disabled);
        if (row.showsAtLimit) {
          expect(screen.getByText(AT_LIMIT_TEXT)).toBeInTheDocument();
        } else {
          expect(screen.queryByText(AT_LIMIT_TEXT)).not.toBeInTheDocument();
        }
      });
    }

    it('shows the observed counts so the reason is legible, not a bare greyed button', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard {...defaultProps} result={{ ...baseResult, unsatisfied: { count: 150, limit: 150 } }} />,
      );

      expect(screen.getByText(/150 of 150/)).toBeInTheDocument();
    });

    it('does not disable a sibling result that carries nothing', () => {
      mockCalculateQuality.mockReturnValue(null);
      const onGrab = vi.fn();
      renderWithProviders(<ReleaseCard {...defaultProps} onGrab={onGrab} result={baseResult} />);

      grabButton().click();

      expect(onGrab).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(AT_LIMIT_TEXT)).not.toBeInTheDocument();
    });

    it('does not fire onGrab for an at-limit result', () => {
      mockCalculateQuality.mockReturnValue(null);
      const onGrab = vi.fn();
      renderWithProviders(
        <ReleaseCard {...defaultProps} onGrab={onGrab} result={{ ...baseResult, unsatisfied: { count: 150, limit: 150 } }} />,
      );

      grabButton().click();

      expect(onGrab).not.toHaveBeenCalled();
    });
  });
  /**
   * #2420 — an ABB result now arrives with an `abb-details://` sentinel instead of a magnet, no
   * seeder count and no size. The sentinel is a non-empty string, so the Grab control stays live
   * with no change to this component; the alternative design (no `downloadUrl` at all) would have
   * disabled the button for every ABB release.
   */
  describe('#2420 — an ABB sentinel-bearing result', () => {
    const abbResult: SearchResult = {
      title: 'Murder in the New Forest',
      indexer: 'AudioBookBay',
      protocol: 'torrent',
      downloadUrl: 'abb-details://https://audiobookbay.test/audio-books/murder-in-the-new-forest/',
      guid: 'abb:/audio-books/murder-in-the-new-forest/',
      detailsUrl: 'https://audiobookbay.test/audio-books/murder-in-the-new-forest/',
      author: 'Carol Cole',
    };

    it('leaves the Grab button enabled and fires onGrab', () => {
      mockCalculateQuality.mockReturnValue(null);
      const onGrab = vi.fn();
      renderWithProviders(<ReleaseCard {...defaultProps} onGrab={onGrab} result={abbResult} />);

      const button = screen.getByRole('button', { name: /Grab/ });
      expect(button).not.toBeDisabled();
      button.click();

      expect(onGrab).toHaveBeenCalledTimes(1);
    });

    it('shows no seeder count and no quality badge for a result carrying neither', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(<ReleaseCard {...defaultProps} result={abbResult} bookDurationSeconds={36000} />);

      expect(screen.queryByText(/seeders/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/MB\/hr/)).not.toBeInTheDocument();
      expect(screen.getByText(/Murder in the New Forest/)).toBeInTheDocument();
    });

    // AC7 — the previously-grabbed badge keys on the guid an ABB grab persists as
    // `books.lastGrabGuid`, which since #2434 is path-derived and survives a mirror hop.
    it('marks it as in library when lastGrabGuid is the path-derived guid', () => {
      mockCalculateQuality.mockReturnValue(null);
      renderWithProviders(
        <ReleaseCard {...defaultProps} result={abbResult} lastGrabGuid={abbResult.guid} />,
      );

      expect(screen.getByText(/In library/i)).toBeInTheDocument();
    });
  });
});
