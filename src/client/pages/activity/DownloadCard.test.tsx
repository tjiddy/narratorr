import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadCard } from './DownloadCard';
import { createMockDownload } from '@/__tests__/factories';
import type { Download } from '@/lib/api';
import type { QualityGateData } from '@/lib/api/activity';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadCard', () => {
  describe('status rendering', () => {
    const allStatuses: Download['status'][] = [
      'queued', 'downloading', 'paused', 'completed', 'checking', 'pending_review', 'processing_queued', 'importing', 'imported', 'failed',
    ];

    it.each(allStatuses)('renders %s status with label', (status) => {
      const labels: Record<Download['status'], string> = {
        queued: 'Queued',
        downloading: 'Downloading',
        paused: 'Paused',
        completed: 'Downloaded',
        checking: 'Checking Quality',
        pending_review: 'Pending Review',
        processing_queued: 'Processing Queued',
        importing: 'Importing',
        imported: 'Imported',
        failed: 'Failed',
      };
      render(<DownloadCard download={createMockDownload({ status })} />);

      expect(screen.getByText(labels[status])).toBeInTheDocument();
    });
  });

  describe('title and metadata', () => {
    it('displays the download title', () => {
      render(<DownloadCard download={createMockDownload({ title: 'My Audiobook' })} />);
      expect(screen.getByText('My Audiobook')).toBeInTheDocument();
    });

    it('displays size when present', () => {
      render(<DownloadCard download={createMockDownload({ size: 1048576 })} />);
      expect(screen.getByText('1 MB')).toBeInTheDocument();
    });

    it('does not display size when absent', () => {
      render(<DownloadCard download={createMockDownload({ size: undefined })} />);
      expect(screen.queryByText(/MB|KB|GB/)).not.toBeInTheDocument();
    });

    it('displays seeders when present', () => {
      render(<DownloadCard download={createMockDownload({ seeders: 12 })} />);
      expect(screen.getByText('12 seeders')).toBeInTheDocument();
    });

    it('displays protocol badge', () => {
      render(<DownloadCard download={createMockDownload({ protocol: 'torrent' })} />);
      expect(screen.getByText('Torrent')).toBeInTheDocument();
    });

    it('displays usenet protocol badge', () => {
      render(<DownloadCard download={createMockDownload({ protocol: 'usenet' })} />);
      expect(screen.getByText('Usenet')).toBeInTheDocument();
    });

    it('hides seeders count when protocol is usenet (#82)', () => {
      render(<DownloadCard download={createMockDownload({ protocol: 'usenet', seeders: 5 })} />);
      expect(screen.queryByText('5 seeders')).not.toBeInTheDocument();
      // Protocol badge still shows
      expect(screen.getByText('Usenet')).toBeInTheDocument();
    });
  });

  describe('error message', () => {
    it('displays error message when present on failed download', () => {
      render(
        <DownloadCard download={createMockDownload({ status: 'failed', errorMessage: 'Tracker error' })} />,
      );
      expect(screen.getByText('Tracker error')).toBeInTheDocument();
    });

    it('displays error message on non-failed status when present', () => {
      // Per reviewer suggestion F4: errorMessage is status-agnostic
      render(
        <DownloadCard download={createMockDownload({ status: 'downloading', errorMessage: 'Tracker warning' })} />,
      );
      expect(screen.getByText('Tracker warning')).toBeInTheDocument();
    });

    it('does not display error section when no error message', () => {
      render(<DownloadCard download={createMockDownload({ status: 'failed' })} />);
      expect(screen.queryByText('Tracker error')).not.toBeInTheDocument();
    });
  });

  describe('progress section', () => {
    it('shows progress when downloading and showProgress is true', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'downloading', progress: 0.45, size: 1048576 })}
          showProgress
        />,
      );
      expect(screen.getByText('45%')).toBeInTheDocument();
    });

    it('hides progress when showProgress is false', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'downloading', progress: 0.45 })}
          showProgress={false}
        />,
      );
      expect(screen.queryByText('45%')).not.toBeInTheDocument();
    });

    it('hides progress for non-downloading statuses', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'completed', progress: 1 })}
          showProgress
        />,
      );
      expect(screen.queryByText('100%')).not.toBeInTheDocument();
    });
  });

  // #282 — Pending review expand/collapse
  describe('pending review expand/collapse (#282)', () => {
    const gateData: QualityGateData = {
      action: 'held',
      mbPerHour: 60,
      existingMbPerHour: 40,
      narratorMatch: true,
      existingNarrator: null,
      downloadNarrator: null,
      durationDelta: 0.05,
      existingDuration: null,
      downloadedDuration: null,
      codec: 'AAC',
      channels: 1,
      existingCodec: null,
      existingChannels: null,
      probeFailure: false,
      probeError: null,
      holdReasons: ['narrator_mismatch'],
    };

    function renderPendingReview(
      downloadOverrides?: Partial<Download>,
      cardProps?: Partial<Omit<Parameters<typeof DownloadCard>[0], 'download'>>,
    ) {
      const user = userEvent.setup();
      const download = createMockDownload({
        status: 'pending_review',
        qualityGate: gateData,
        ...downloadOverrides,
      });
      const result = render(
        <DownloadCard
          download={download}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
          {...cardProps}
        />,
      );
      return { user, download, ...result };
    }

    it('pending_review downloads show expand/collapse toggle', () => {
      renderPendingReview();
      const toggle = screen.getByRole('button', { name: /expand quality comparison/i });
      expect(toggle).toBeInTheDocument();
    });

    it('comparison panel is collapsed by default', () => {
      renderPendingReview();
      const toggle = screen.getByRole('button', { name: /expand quality comparison/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
    });

    it('clicking expand toggle reveals QualityComparisonPanel', async () => {
      const { user } = renderPendingReview();
      const toggle = screen.getByRole('button', { name: /expand quality comparison/i });
      await user.click(toggle);
      expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('approve/reject/reject-and-search buttons render inside expanded panel', async () => {
      const { user } = renderPendingReview();
      // Before expanding, no approve/reject buttons
      expect(screen.queryByText('Approve')).not.toBeInTheDocument();
      expect(screen.queryByText('Reject')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));
      expect(screen.getByText('Approve')).toBeInTheDocument();
      expect(screen.getByText('Reject')).toBeInTheDocument();
      expect(screen.getByText('Reject & Search')).toBeInTheDocument();
    });

    it('approve button shows pending state while approving', async () => {
      const { user } = renderPendingReview(undefined, { isApproving: true });
      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));

      const approveBtn = screen.getByText('Approving...');
      expect(approveBtn).toBeInTheDocument();
      expect(approveBtn.closest('button')).toBeDisabled();
      // Panel remains expanded during the async operation
      expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
    });

    it('reject button shows pending state while rejecting and disables both reject buttons', async () => {
      const { user } = renderPendingReview(undefined, { isRejecting: true });
      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));

      const rejectBtn = screen.getByText('Rejecting...');
      expect(rejectBtn).toBeInTheDocument();
      expect(rejectBtn.closest('button')).toBeDisabled();
      // Reject & Search is also disabled during pending state
      expect(screen.getByText('Reject & Search').closest('button')).toBeDisabled();
      // Panel remains expanded during the async operation
      expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
    });

    it('panel is not rendered when status changes away from pending_review', () => {
      // When the download status changes (parent re-renders with different status),
      // PendingReviewDetails is not rendered, effectively "collapsing" the panel
      render(
        <DownloadCard
          download={createMockDownload({ status: 'importing' })}
        />,
      );
      expect(screen.queryByRole('button', { name: /expand quality comparison/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
      expect(screen.queryByText('Approve')).not.toBeInTheDocument();
      expect(screen.queryByText('Reject')).not.toBeInTheDocument();
    });

    it('handles null quality gate data — shows reject buttons without comparison panel', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: undefined })}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
        />,
      );
      // No expand toggle or comparison panel when qualityGate is absent
      expect(screen.queryByRole('button', { name: /expand quality comparison/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
      // But reject buttons are still shown (#301)
      expect(screen.getByText('Reject')).toBeInTheDocument();
      expect(screen.getByText('Reject & Search')).toBeInTheDocument();
    });

    it('handles probeFailure=true with warning', async () => {
      const { user } = renderPendingReview({
        qualityGate: { ...gateData, probeFailure: true },
      });
      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));
      expect(screen.getByText('Probe failed')).toBeInTheDocument();
      expect(screen.getByText(/unable to determine/i)).toBeInTheDocument();
    });
  });

  describe('orphaned downloads (bookId null)', () => {
    it('shows title and errorMessage for an orphaned failed download', () => {
      render(
        <DownloadCard
          download={createMockDownload({
            status: 'failed',
            bookId: null,
            title: 'Orphaned Audiobook',
            errorMessage: 'Download failed — source unavailable',
          })}
        />,
      );
      expect(screen.getByText('Orphaned Audiobook')).toBeInTheDocument();
      expect(screen.getByText('Download failed — source unavailable')).toBeInTheDocument();
    });

    it('does not show retry button for an orphaned failed download with bookId null', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'failed', bookId: null })}
          onRetry={vi.fn()}
        />,
      );
      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('renders with compact styling', () => {
      const { container } = render(
        <DownloadCard download={createMockDownload()} compact />,
      );
      // Compact mode uses p-4 instead of p-5
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain('p-4');
    });

    it('renders with default (non-compact) styling', () => {
      const { container } = render(
        <DownloadCard download={createMockDownload()} />,
      );
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain('p-5');
    });
  });

  describe('indexer name (#57)', () => {
    it('renders indexer name text when indexerName is a non-empty string', () => {
      render(<DownloadCard download={createMockDownload({ indexerName: 'AudioBookBay' })} />);
      expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
    });

    it('renders without indexer name when indexerName is null', () => {
      render(<DownloadCard download={createMockDownload({ indexerName: null })} />);
      expect(screen.queryByText('AudioBookBay')).not.toBeInTheDocument();
    });

    it('renders without indexer name when indexerName is undefined', () => {
      const { container } = render(<DownloadCard download={createMockDownload({ indexerName: undefined })} />);
      // no indexer span — just verify no crash and no extra text
      expect(container).toBeInTheDocument();
    });
  });

  // #301 — Split reject into Reject (dismiss) and Reject & Search
  describe('split reject buttons (#301)', () => {
    const gateData301: QualityGateData = {
      action: 'held',
      mbPerHour: 60,
      existingMbPerHour: 40,
      narratorMatch: true,
      existingNarrator: null,
      downloadNarrator: null,
      durationDelta: 0.05,
      existingDuration: null,
      downloadedDuration: null,
      codec: 'AAC',
      channels: 1,
      existingCodec: null,
      existingChannels: null,
      probeFailure: false,
      probeError: null,
      holdReasons: ['narrator_mismatch'],
    };

    it('both Reject and Reject & Search buttons render on pending_review downloads with qualityGate data', async () => {
      const user = userEvent.setup();
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: gateData301 })}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));
      expect(screen.getByText('Reject')).toBeInTheDocument();
      expect(screen.getByText('Reject & Search')).toBeInTheDocument();
    });

    it('both Reject and Reject & Search buttons render on pending_review downloads without qualityGate data', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: undefined })}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
        />,
      );

      // No expand toggle needed — buttons render directly
      expect(screen.getByText('Reject')).toBeInTheDocument();
      expect(screen.getByText('Reject & Search')).toBeInTheDocument();
    });

    it('clicking Reject calls onReject callback', async () => {
      const user = userEvent.setup();
      const onReject = vi.fn();
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: undefined })}
          onReject={onReject}
          onRejectWithSearch={vi.fn()}
        />,
      );

      await user.click(screen.getByText('Reject'));
      expect(onReject).toHaveBeenCalledTimes(1);
    });

    it('clicking Reject & Search calls onRejectWithSearch callback', async () => {
      const user = userEvent.setup();
      const onRejectWithSearch = vi.fn();
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: undefined })}
          onReject={vi.fn()}
          onRejectWithSearch={onRejectWithSearch}
        />,
      );

      await user.click(screen.getByText('Reject & Search'));
      expect(onRejectWithSearch).toHaveBeenCalledTimes(1);
    });

    it('Reject and Reject & Search buttons not shown on non-pending downloads', () => {
      render(
        <DownloadCard
          download={createMockDownload({ status: 'failed' })}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
        />,
      );

      expect(screen.queryByText('Reject')).not.toBeInTheDocument();
      expect(screen.queryByText('Reject & Search')).not.toBeInTheDocument();
    });

    it('Reject button has primary destructive styling, Reject & Search has secondary/outline styling', async () => {
      const user = userEvent.setup();
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: gateData301 })}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));
      const rejectBtn = screen.getByText('Reject').closest('button')!;
      const rejectSearchBtn = screen.getByText('Reject & Search').closest('button')!;

      // Primary reject has filled background, secondary has border/outline
      expect(rejectBtn.className).toContain('bg-destructive');
      expect(rejectSearchBtn.className).toContain('border');
    });

    it('loading state: rejecting disables both buttons and shows spinner', async () => {
      const user = userEvent.setup();
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: gateData301 })}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
          isRejecting
        />,
      );

      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));
      expect(screen.getByText('Rejecting...').closest('button')).toBeDisabled();
      expect(screen.getByText('Reject & Search').closest('button')).toBeDisabled();
    });

    it('loading state: approving disables both reject buttons', async () => {
      const user = userEvent.setup();
      render(
        <DownloadCard
          download={createMockDownload({ status: 'pending_review', qualityGate: gateData301 })}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRejectWithSearch={vi.fn()}
          isApproving
        />,
      );

      await user.click(screen.getByRole('button', { name: /expand quality comparison/i }));
      expect(screen.getByText('Reject').closest('button')).toBeDisabled();
      expect(screen.getByText('Reject & Search').closest('button')).toBeDisabled();
    });
  });

  describe('AC5 — reject button spinner scoping', () => {
    it.todo('shows spinner on Reject button only when reject action is pending for this card');
    it.todo('shows spinner on Reject & Search button only when reject-with-search is pending for this card');
    it.todo('shows no spinner on either button when reject is pending for a different card');
    it.todo('disables both buttons on this card when either reject action is pending for this card');
  });
});
