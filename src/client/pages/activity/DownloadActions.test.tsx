import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadActions } from './DownloadActions';
import { createMockDownload } from '@/__tests__/factories';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadActions', () => {
  describe('retry button', () => {
    it('shows retry button for failed status when onRetry provided', () => {
      const download = createMockDownload({ status: 'failed', bookId: 1 });
      render(<DownloadActions download={download} onRetry={vi.fn()} />);

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('does not show retry button for failed status without onRetry', () => {
      const download = createMockDownload({ status: 'failed' });
      render(<DownloadActions download={download} />);

      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });

    it('calls onRetry when retry button is clicked', async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      const download = createMockDownload({ status: 'failed', bookId: 1 });
      render(<DownloadActions download={download} onRetry={onRetry} />);

      await user.click(screen.getByText('Retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not show retry for non-failed statuses', () => {
      const statuses = ['queued', 'downloading', 'paused', 'completed', 'checking', 'pending_review', 'importing', 'imported'] as const;
      for (const status of statuses) {
        const { unmount } = render(
          <DownloadActions download={createMockDownload({ status })} onRetry={vi.fn()} />,
        );
        expect(screen.queryByText('Retry')).not.toBeInTheDocument();
        unmount();
      }
    });

    it('does not show retry button when bookId is null (orphaned download — primary runtime case from SET NULL FK)', () => {
      const download = createMockDownload({ status: 'failed', bookId: null });
      render(<DownloadActions download={download} onRetry={vi.fn()} />);

      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });

    it('does not show retry button when bookId is undefined (defensive: missing field)', () => {
      const download = createMockDownload({ status: 'failed', bookId: undefined });
      render(<DownloadActions download={download} onRetry={vi.fn()} />);

      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });

    it('disables retry button and shows Retrying... label when isRetrying is true', () => {
      const download = createMockDownload({ status: 'failed', bookId: 1 });
      render(<DownloadActions download={download} onRetry={vi.fn()} isRetrying />);

      const button = screen.getByRole('button', { name: /retrying/i });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Retrying...');
    });

    it('enables retry button and shows Retry label when isRetrying is false', () => {
      const download = createMockDownload({ status: 'failed', bookId: 1 });
      render(<DownloadActions download={download} onRetry={vi.fn()} isRetrying={false} />);

      const button = screen.getByRole('button', { name: /^retry$/i });
      expect(button).not.toBeDisabled();
    });
  });

  describe('cancel button', () => {
    it.each(['queued', 'downloading', 'paused'] as const)(
      'shows cancel button for %s status when onCancel provided',
      (status) => {
        const download = createMockDownload({ status });
        render(<DownloadActions download={download} onCancel={vi.fn()} />);

        expect(screen.getByText('Cancel & Blacklist')).toBeInTheDocument();
      },
    );

    it('does not show cancel button without onCancel', () => {
      const download = createMockDownload({ status: 'downloading' });
      render(<DownloadActions download={download} />);

      expect(screen.queryByText('Cancel & Blacklist')).not.toBeInTheDocument();
    });

    it('calls onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      const download = createMockDownload({ status: 'queued' });
      render(<DownloadActions download={download} onCancel={onCancel} />);

      await user.click(screen.getByText('Cancel & Blacklist'));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('shows Cancelling... text and disables button when isCancelling', () => {
      const download = createMockDownload({ status: 'downloading' });
      render(
        <DownloadActions download={download} onCancel={vi.fn()} isCancelling />,
      );

      const button = screen.getByText('Cancelling...').closest('button')!;
      expect(button).toBeDisabled();
    });

    it.each(['completed', 'importing', 'imported', 'failed'] as const)(
      'does not show cancel button for %s status',
      (status) => {
        render(
          <DownloadActions download={createMockDownload({ status })} onCancel={vi.fn()} />,
        );
        expect(screen.queryByText('Cancel & Blacklist')).not.toBeInTheDocument();
      },
    );

    // #315 — button label change
    it('shows "Cancel & Blacklist" label instead of "Cancel" for active downloads', () => {
      const download = createMockDownload({ status: 'downloading' });
      render(<DownloadActions download={download} onCancel={vi.fn()} />);

      expect(screen.getByText('Cancel & Blacklist')).toBeInTheDocument();
      expect(screen.queryByText(/^Cancel$/)).not.toBeInTheDocument();
    });
  });

  describe('no action buttons', () => {
    it('renders no buttons for completed status', () => {
      render(
        <DownloadActions
          download={createMockDownload({ status: 'completed' })}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('renders no buttons for imported status', () => {
      render(
        <DownloadActions
          download={createMockDownload({ status: 'imported' })}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('renders no buttons for importing status', () => {
      render(
        <DownloadActions
          download={createMockDownload({ status: 'importing' })}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('delete button', () => {
    it.each(['completed', 'imported', 'failed'] as const)(
      'renders delete button for %s status',
      (status) => {
        const download = createMockDownload({ status });
        render(<DownloadActions download={download} onDelete={vi.fn()} />);
        expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
      },
    );

    it.each(['pending_review', 'downloading', 'queued', 'paused', 'checking', 'processing_queued', 'importing'] as const)(
      'does not render delete button for %s status',
      (status) => {
        const download = createMockDownload({ status });
        render(<DownloadActions download={download} onDelete={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
      },
    );

    it('does not render delete button when onDelete prop is not provided', () => {
      const download = createMockDownload({ status: 'completed' });
      render(<DownloadActions download={download} />);
      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });

    it('calls onDelete when delete button is clicked', async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn();
      const download = createMockDownload({ status: 'completed' });
      render(<DownloadActions download={download} onDelete={onDelete} />);

      await user.click(screen.getByRole('button', { name: /delete/i }));
      expect(onDelete).toHaveBeenCalledOnce();
    });

    it('shows both Retry and Delete for failed status with non-null bookId', () => {
      const download = createMockDownload({ status: 'failed', bookId: 1 });
      render(<DownloadActions download={download} onRetry={vi.fn()} onDelete={vi.fn()} />);

      expect(screen.getByText('Retry')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('disables delete button and shows Deleting... label when isDeleting is true', () => {
      const download = createMockDownload({ status: 'completed' });
      render(<DownloadActions download={download} onDelete={vi.fn()} isDeleting />);

      const btn = screen.getByRole('button', { name: /delete/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent('Deleting...');
    });
  });

});
