import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QualityComparisonPanel } from './QualityComparisonPanel';
import { DownloadCard } from './DownloadCard';
import { createMockDownload } from '@/__tests__/factories';
import type { QualityGateData } from '@/lib/api/activity';

const baseGateData: QualityGateData = {
  action: 'held',
  mbPerHour: 60,
  existingMbPerHour: 40,
  narratorMatch: true,
  durationDelta: 0.05,
  codec: 'AAC',
  channels: 1,
  probeFailure: false,
  holdReasons: ['narrator_mismatch'],
};

describe('QualityComparisonPanel', () => {
  it('renders current vs new MB/hr comparison', () => {
    render(<QualityComparisonPanel data={baseGateData} />);

    expect(screen.getByText('60 MB/hr')).toBeInTheDocument();
    expect(screen.getByText('40 MB/hr')).toBeInTheDocument();
  });

  it('renders narrator match status', () => {
    render(<QualityComparisonPanel data={baseGateData} />);
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('renders narrator mismatch status', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, narratorMatch: false }} />);
    expect(screen.getByText('Mismatch')).toBeInTheDocument();
  });

  it('renders codec and channel info', () => {
    render(<QualityComparisonPanel data={baseGateData} />);
    expect(screen.getByText('AAC')).toBeInTheDocument();
    expect(screen.getByText('Mono')).toBeInTheDocument();
  });

  it('shows stereo label when channels is 2', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, channels: 2 }} />);
    expect(screen.getByText('Stereo')).toBeInTheDocument();
  });

  it('does not show stereo flag for mono audio', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, channels: 1 }} />);
    expect(screen.getByText('Mono')).toBeInTheDocument();
    expect(screen.queryByText('Stereo')).not.toBeInTheDocument();
  });

  it('shows probe failure context when probeFailure is true', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, probeFailure: true }} />);
    expect(screen.getByText('Probe failed')).toBeInTheDocument();
    expect(screen.getByText(/unable to determine/i)).toBeInTheDocument();
  });

  it('renders hold reasons as badges', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, holdReasons: ['narrator_mismatch', 'duration_delta'] }} />);
    expect(screen.getByText('narrator mismatch')).toBeInTheDocument();
    expect(screen.getByText('duration delta')).toBeInTheDocument();
  });
});

describe('DownloadCard - pending_review', () => {
  async function expandPendingReview() {
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { expanded: false });
    await user.click(toggle);
    return user;
  }

  it('shows approve button for pending_review downloads after expanding', async () => {
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    await expandPendingReview();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('shows reject button for pending_review downloads after expanding', async () => {
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    await expandPendingReview();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('does not show approve/reject buttons for non-pending_review downloads', () => {
    const download = createMockDownload({ status: 'downloading' });
    render(<DownloadCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject')).not.toBeInTheDocument();
  });

  it('calls onApprove when approve clicked', async () => {
    const onApprove = vi.fn();
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadCard download={download} onApprove={onApprove} onReject={vi.fn()} />);

    const user = await expandPendingReview();
    await user.click(screen.getByText('Approve'));
    expect(onApprove).toHaveBeenCalled();
  });

  it('calls onReject when reject clicked', async () => {
    const onReject = vi.fn();
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadCard download={download} onApprove={vi.fn()} onReject={onReject} />);

    const user = await expandPendingReview();
    await user.click(screen.getByText('Reject'));
    expect(onReject).toHaveBeenCalled();
  });

  it('renders checking status as processing indicator', () => {
    const download = createMockDownload({ status: 'checking' });
    render(<DownloadCard download={download} />);

    expect(screen.getByText('Checking audio quality...')).toBeInTheDocument();
  });

  it('renders comparison panel for pending_review with quality gate data after expanding', async () => {
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    await expandPendingReview();
    expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
  });
});
