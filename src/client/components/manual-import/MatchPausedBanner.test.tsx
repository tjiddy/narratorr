import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MatchPausedBanner } from './MatchPausedBanner';
import { PAUSED_REASON_DETAIL, pausedReasonDetail, type PausedReason } from '@/hooks/match-recovery';

const ALL_REASONS: PausedReason[] = ['start-failed', 'unreachable', 'request-rejected', 'run-expired', 'cancelled'];

// Copy rule (#1864 §5): domain wording only — never raw error/server text, status
// codes, or transport vocabulary. Covers server-derived strings, not just "chunk".
const FORBIDDEN = ['chunk', 'job', 'poll', '404', 'http', '500', 'not found', 'expired', 'rejected the request', 'network'];

describe('PausedReason → detail mapping (#1864 §5a)', () => {
  it('is total — every reason maps to exactly one non-empty detail string', () => {
    for (const reason of ALL_REASONS) {
      expect(PAUSED_REASON_DETAIL[reason]).toBeTruthy();
      expect(pausedReasonDetail(reason)).toBe(PAUSED_REASON_DETAIL[reason]);
    }
    // No extra members beyond the closed union.
    expect(Object.keys(PAUSED_REASON_DETAIL).sort()).toEqual([...ALL_REASONS].sort());
  });

  it('never leaks forbidden transport/server vocabulary into any detail string', () => {
    for (const reason of ALL_REASONS) {
      const copy = pausedReasonDetail(reason).toLowerCase();
      for (const term of FORBIDDEN) {
        expect(copy).not.toContain(term);
      }
    }
  });
});

describe('MatchPausedBanner (#1864 §5)', () => {
  const noop = () => {};

  it('renders the remaining/total book count and the reason-mapped detail', () => {
    render(<MatchPausedBanner reason="run-expired" remaining={26} total={300} onResume={noop} onRestart={noop} busy={false} />);
    expect(screen.getByText(/26 of 300 books remaining/i)).toBeInTheDocument();
    expect(screen.getByText(pausedReasonDetail('run-expired'))).toBeInTheDocument();
  });

  it('renders every reason with a single detail string (no raw error text)', () => {
    for (const reason of ALL_REASONS) {
      const { unmount } = render(<MatchPausedBanner reason={reason} remaining={1} total={2} onResume={noop} onRestart={noop} busy={false} />);
      expect(screen.getByText(pausedReasonDetail(reason))).toBeInTheDocument();
      unmount();
    }
  });

  it('Resume and Restart are single-submit — disabled while busy', () => {
    const onResume = vi.fn();
    const onRestart = vi.fn();
    render(<MatchPausedBanner reason="unreachable" remaining={1} total={2} onResume={onResume} onRestart={onRestart} busy />);
    expect(screen.getByRole('button', { name: /resume remaining/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /restart all/i })).toBeDisabled();
  });

  it('invokes the callbacks when enabled', async () => {
    const onResume = vi.fn();
    const onRestart = vi.fn();
    render(<MatchPausedBanner reason="unreachable" remaining={1} total={2} onResume={onResume} onRestart={onRestart} busy={false} />);
    await userEvent.click(screen.getByRole('button', { name: /resume remaining/i }));
    await userEvent.click(screen.getByRole('button', { name: /restart all/i }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onRestart).toHaveBeenCalledOnce();
  });
});
