import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DownloadCard } from './DownloadCard';
import { createMockDownload } from '@/__tests__/factories';
import type { Download } from '@/lib/api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadCard', () => {
  describe('status rendering', () => {
    const allStatuses: Download['status'][] = [
      'queued', 'downloading', 'paused', 'completed', 'checking', 'pending_review', 'importing', 'imported', 'failed',
    ];

    it.each(allStatuses)('renders %s status with label', (status) => {
      const labels: Record<Download['status'], string> = {
        queued: 'Queued',
        downloading: 'Downloading',
        paused: 'Paused',
        completed: 'Completed',
        checking: 'Checking Quality',
        pending_review: 'Pending Review',
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
});
