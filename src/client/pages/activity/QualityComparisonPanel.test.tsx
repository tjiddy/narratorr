import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QualityComparisonPanel } from './QualityComparisonPanel';
import { DownloadActivityCard } from './DownloadActivityCard';
import { createMockDownload } from '@/__tests__/factories';
import type { QualityGateData } from '@/lib/api/activity';

const baseGateData: QualityGateData = {
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

describe('QualityComparisonPanel', () => {
  it('renders current vs new MB/hr comparison', () => {
    render(<QualityComparisonPanel data={baseGateData} />);

    expect(screen.getByText('60 MB/hr')).toBeInTheDocument();
    expect(screen.getByText('40 MB/hr')).toBeInTheDocument();
  });

  it('renders narrator row in the comparison grid when narratorMatch is set', () => {
    render(<QualityComparisonPanel data={baseGateData} />);
    expect(screen.getByText('Narrator')).toBeInTheDocument();
  });

  it('renders narrator mismatch row with warning icon', () => {
    const { container } = render(<QualityComparisonPanel data={{ ...baseGateData, narratorMatch: false, existingNarrator: 'John Smith', downloadNarrator: 'Jane Doe' }} />);
    expect(screen.getByText('Narrator')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
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

describe('DownloadActivityCard - pending_review', () => {
  async function expandPendingReview() {
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { expanded: false });
    await user.click(toggle);
    return user;
  }

  it('shows approve button for pending_review downloads after expanding', async () => {
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadActivityCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    await expandPendingReview();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('shows reject button for pending_review downloads after expanding', async () => {
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadActivityCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    await expandPendingReview();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('does not show approve/reject buttons for non-pending_review downloads', () => {
    const download = createMockDownload({ status: 'downloading' });
    render(<DownloadActivityCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject')).not.toBeInTheDocument();
  });

  it('calls onApprove when approve clicked', async () => {
    const onApprove = vi.fn();
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadActivityCard download={download} onApprove={onApprove} onReject={vi.fn()} />);

    const user = await expandPendingReview();
    await user.click(screen.getByText('Approve'));
    expect(onApprove).toHaveBeenCalled();
  });

  it('calls onReject when reject clicked', async () => {
    const onReject = vi.fn();
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadActivityCard download={download} onApprove={vi.fn()} onReject={onReject} />);

    const user = await expandPendingReview();
    await user.click(screen.getByText('Reject'));
    expect(onReject).toHaveBeenCalled();
  });

  it('renders checking status as processing indicator', () => {
    const download = createMockDownload({ status: 'checking' });
    render(<DownloadActivityCard download={download} />);

    expect(screen.getByText('Checking audio quality...')).toBeInTheDocument();
  });

  it('renders comparison panel for pending_review with quality gate data after expanding', async () => {
    const download = createMockDownload({ status: 'pending_review', qualityGate: baseGateData });
    render(<DownloadActivityCard download={download} onApprove={vi.fn()} onReject={vi.fn()} />);

    await expandPendingReview();
    expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
  });
});

describe('QualityComparisonPanel — narrator names', () => {
  it('shows both existingNarrator and downloadNarrator when narratorMatch is false', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, narratorMatch: false, existingNarrator: 'John Smith', downloadNarrator: 'Jane Doe' }} />);
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows both narrator names when narratorMatch is true', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, narratorMatch: true, existingNarrator: 'John Smith', downloadNarrator: 'John Smith' }} />);
    expect(screen.getAllByText('John Smith')).toHaveLength(2);
  });

  it('shows narrator row with dashes when narratorMatch is not null but names are missing (legacy)', () => {
    const { container } = render(<QualityComparisonPanel data={{ ...baseGateData, narratorMatch: false, existingNarrator: null, downloadNarrator: null }} />);
    expect(screen.getByText('Narrator')).toBeInTheDocument();
    // Two em-dashes appear in narrator current and downloaded columns
    const dashes = container.querySelectorAll('*');
    const dashElements = Array.from(dashes).filter(el => el.textContent === '—');
    expect(dashElements.length).toBeGreaterThanOrEqual(2);
  });

  it('hides narrator row entirely when narratorMatch is null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, narratorMatch: null, existingNarrator: null, downloadNarrator: null }} />);
    expect(screen.queryByText('Narrator')).not.toBeInTheDocument();
  });
});

describe('QualityComparisonPanel — probe error display', () => {
  it('shows specific probeError text when probeFailure=true and probeError present', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, probeFailure: true, probeError: 'No audio files found', holdReasons: ['probe_failed'] }} />);
    expect(screen.getByText(/No audio files found/)).toBeInTheDocument();
  });

  it('shows generic Audio probe failed message when probeFailure=true and probeError null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, probeFailure: true, probeError: null, holdReasons: ['probe_failed'] }} />);
    expect(screen.getByText(/Audio probe failed/)).toBeInTheDocument();
  });

  it('shows Unexpected error heading when holdReasons includes unhandled_error with probeError present', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, probeFailure: true, probeError: 'DB connection lost', holdReasons: ['unhandled_error'] }} />);
    expect(screen.getByText(/Unexpected error/)).toBeInTheDocument();
    expect(screen.getByText(/DB connection lost/)).toBeInTheDocument();
  });

  it('shows Unexpected error heading with generic body when unhandled_error + null probeError (legacy event)', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, probeFailure: true, probeError: null, holdReasons: ['unhandled_error'] }} />);
    expect(screen.getByText(/Unexpected error/)).toBeInTheDocument();
    expect(screen.getByText(/unexpected error occurred/i)).toBeInTheDocument();
  });
});

describe('QualityComparisonPanel — existing audio metadata display', () => {
  it('renders existing codec in Current column when existingCodec is non-null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingCodec: 'AAC', codec: 'MP3' }} />);
    expect(screen.getByText('AAC')).toBeInTheDocument();
    expect(screen.getByText('MP3')).toBeInTheDocument();
  });

  it('renders existing channels with Mono/Stereo/Nch formatting when existingChannels is non-null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingChannels: 2, channels: 1 }} />);
    expect(screen.getByText('Stereo')).toBeInTheDocument();
    expect(screen.getByText('Mono')).toBeInTheDocument();
  });

  it('renders existing duration formatted as "Xh Ym" when existingDuration is non-null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingDuration: 51840, downloadedDuration: 51840, durationDelta: 0 }} />);
    // 51840s = 14h 24m
    expect(screen.getAllByText('14h 24m')).toHaveLength(2);
  });

  it('renders downloadedDuration formatted as "Xh Ym" in Downloaded column', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingDuration: null, downloadedDuration: 3660, durationDelta: null }} />);
    // 3660s = 1h 1m
    expect(screen.getByText('1h 1m')).toBeInTheDocument();
  });

  it('shows absolute duration values for both sides (not relative delta %)', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingDuration: 7200, downloadedDuration: 7500, durationDelta: 0.042 }} />);
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.getByText('2h 5m')).toBeInTheDocument();
    // Should NOT render delta percentage
    expect(screen.queryByText('+4%')).not.toBeInTheDocument();
  });

  it('flags duration row when durationDelta exceeds 15% tolerance', () => {
    const { container } = render(<QualityComparisonPanel data={{
      ...baseGateData, existingDuration: 7200, downloadedDuration: 9000,
      durationDelta: 0.25, narratorMatch: null,
    }} />);
    // Should have a warning icon on the duration row
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag duration row when delta is exactly 15% (boundary exclusive)', () => {
    const { container } = render(<QualityComparisonPanel data={{
      ...baseGateData, existingDuration: 7200, downloadedDuration: 8280,
      durationDelta: 0.15, narratorMatch: null, codec: null, channels: null,
      existingCodec: null, existingChannels: null,
    }} />);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('shows dashes when existing codec/channels/duration are null', () => {
    const { container } = render(<QualityComparisonPanel data={{
      ...baseGateData, existingCodec: null, existingChannels: null, existingDuration: null,
      codec: 'AAC', channels: 2, downloadedDuration: 7200, durationDelta: null,
    }} />);
    const dashes = Array.from(container.querySelectorAll('*')).filter(el => el.textContent === '—');
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it('does NOT render codec row when both existing and downloaded codec are null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingCodec: null, codec: null }} />);
    expect(screen.queryByText('Codec')).not.toBeInTheDocument();
  });

  it('does NOT render channels row when both existing and downloaded channels are null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingChannels: null, channels: null }} />);
    expect(screen.queryByText('Channels')).not.toBeInTheDocument();
  });

  it('does NOT render duration row when both existingDuration and downloadedDuration are null', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, existingDuration: null, downloadedDuration: null, durationDelta: null }} />);
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
  });

  it('renders channels formatting: 1→Mono, 2→Stereo, 6→6ch for existing side', () => {
    const { rerender } = render(<QualityComparisonPanel data={{ ...baseGateData, existingChannels: 1, channels: 1 }} />);
    expect(screen.getAllByText('Mono')).toHaveLength(2);

    rerender(<QualityComparisonPanel data={{ ...baseGateData, existingChannels: 2, channels: 2 }} />);
    expect(screen.getAllByText('Stereo')).toHaveLength(2);

    rerender(<QualityComparisonPanel data={{ ...baseGateData, existingChannels: 6, channels: 6 }} />);
    expect(screen.getAllByText('6ch')).toHaveLength(2);
  });
});

describe('QualityComparisonPanel — legacy backward compatibility', () => {
  it('renders correctly when new fields are absent from data (legacy event)', () => {
    // Simulate a legacy event object missing the new fields entirely
    const legacyData = {
      action: 'held' as const,
      mbPerHour: 60,
      existingMbPerHour: 40,
      narratorMatch: null,
      existingNarrator: null,
      downloadNarrator: null,
      durationDelta: null,
      codec: 'AAC',
      channels: 2,
      probeFailure: false,
      probeError: null,
      holdReasons: [],
    } as unknown as QualityGateData;

    // Should not throw — legacy fields missing should render as dashes/hidden
    render(<QualityComparisonPanel data={legacyData} />);
    expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
    expect(screen.getByText('AAC')).toBeInTheDocument();
    expect(screen.getByText('Stereo')).toBeInTheDocument();
  });
});

describe('QualityComparisonPanel — stereo flag removal', () => {
  it('renders Stereo without warning icon for channels=2', () => {
    const { container } = render(<QualityComparisonPanel data={{ ...baseGateData, channels: 2, probeFailure: false, durationDelta: null, narratorMatch: null }} />);
    expect(screen.getByText('Stereo')).toBeInTheDocument();
    // No AlertTriangleIcon SVGs when no rows are flagged
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('renders Mono without flag for channels=1', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, channels: 1 }} />);
    expect(screen.getByText('Mono')).toBeInTheDocument();
  });

  it('renders 6ch without flag for channels=6', () => {
    render(<QualityComparisonPanel data={{ ...baseGateData, channels: 6 }} />);
    expect(screen.getByText('6ch')).toBeInTheDocument();
  });
});
