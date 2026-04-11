import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MergeStatusIcon } from './MergeStatusIcon';
import type { MergeOutcome } from '@/hooks/useMergeProgress';

function getIconClass(container: HTMLElement): string {
  const svg = container.querySelector('svg');
  return svg?.className.baseVal ?? svg?.getAttribute('class') ?? '';
}

describe('MergeStatusIcon', () => {
  describe('outcome icons', () => {
    it('renders success icon with text-success class when outcome is success', () => {
      const { container } = render(<MergeStatusIcon outcome="success" phase="complete" />);
      expect(getIconClass(container)).toContain('text-success');
    });

    it('renders error icon with text-destructive class when outcome is error', () => {
      const { container } = render(<MergeStatusIcon outcome="error" phase="failed" />);
      expect(getIconClass(container)).toContain('text-destructive');
    });

    it('renders cancelled icon with text-muted-foreground class when outcome is cancelled', () => {
      const { container } = render(<MergeStatusIcon outcome="cancelled" phase="cancelled" />);
      expect(getIconClass(container)).toContain('text-muted-foreground');
    });
  });

  describe('non-terminal icons', () => {
    it('renders LoadingSpinner when outcome is undefined and phase is queued', () => {
      render(<MergeStatusIcon phase="queued" />);
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });

    it('renders spinning RefreshIcon when outcome is undefined and phase is processing', () => {
      const { container } = render(<MergeStatusIcon phase="processing" />);
      expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
      const cls = getIconClass(container);
      expect(cls).toContain('animate-spin');
      expect(cls).toContain('text-primary');
    });
  });

  describe('type safety', () => {
    it('rejects invalid outcome literal at compile time', () => {
      // @ts-expect-error — 'unknown' is not assignable to MergeOutcome
      const _invalidOutcome: MergeOutcome = 'unknown';
      expect(_invalidOutcome).toBe('unknown');
    });
  });
});
