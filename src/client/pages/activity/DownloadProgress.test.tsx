import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DownloadProgress } from './DownloadProgress';
import { createMockDownload } from '@/__tests__/factories';

describe('DownloadProgress', () => {
  it('displays formatted progress percentage', () => {
    const download = createMockDownload({ progress: 0.45, size: 524288000 });
    render(<DownloadProgress download={download} />);

    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('displays 0% progress', () => {
    const download = createMockDownload({ progress: 0, size: 100000 });
    render(<DownloadProgress download={download} />);

    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('displays 100% progress', () => {
    const download = createMockDownload({ progress: 1, size: 100000 });
    render(<DownloadProgress download={download} />);

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('displays bytes downloaded and total when size is present', () => {
    const download = createMockDownload({ progress: 0.5, size: 1048576 }); // 1 MB
    render(<DownloadProgress download={download} />);

    // 0.5 * 1048576 = 524288 bytes = 512 KB
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/512 KB/)).toBeInTheDocument();
    expect(screen.getByText(/1 MB/)).toBeInTheDocument();
  });

  it('omits bytes text when size is undefined', () => {
    const download = createMockDownload({ progress: 0.5, size: undefined });
    render(<DownloadProgress download={download} />);

    expect(screen.getByText('50%')).toBeInTheDocument();
    // No bytes text — only the percentage should appear
    expect(screen.queryByText(/MB|KB|GB|B/)).not.toBeInTheDocument();
  });

  it('renders the progress bar fill element', () => {
    const download = createMockDownload({ progress: 0.75, size: 1000 });
    const { container } = render(<DownloadProgress download={download} />);

    // The progress fill div has an inline style with width based on progress
    const fills = container.querySelectorAll('[style]');
    const fillStyles = Array.from(fills).map(el => (el as HTMLElement).style.width);
    expect(fillStyles).toContain('75%');
  });

  describe('download speed label', () => {
    it('renders the formatted speed when downloadSpeed is a positive number', () => {
      const download = createMockDownload({ progress: 0.5, size: 1_000_000, downloadSpeed: 1_048_576 });
      render(<DownloadProgress download={download} />);
      expect(screen.getByText(/1\.0 MB\/s/)).toBeInTheDocument();
    });

    it('renders "0 KB/s" when downloadSpeed is 0 (stalled signal)', () => {
      const download = createMockDownload({ progress: 0.5, size: 1_000_000, downloadSpeed: 0 });
      render(<DownloadProgress download={download} />);
      expect(screen.getByText(/0 KB\/s/)).toBeInTheDocument();
    });

    it('omits the speed label when downloadSpeed is null', () => {
      const download = createMockDownload({ progress: 0.5, size: 1_000_000, downloadSpeed: null });
      render(<DownloadProgress download={download} />);
      expect(screen.queryByText(/\/s/)).not.toBeInTheDocument();
    });

    it('omits the speed label when downloadSpeed is undefined', () => {
      const download = createMockDownload({ progress: 0.5, size: 1_000_000 });
      render(<DownloadProgress download={download} />);
      expect(screen.queryByText(/\/s/)).not.toBeInTheDocument();
    });
  });
});
