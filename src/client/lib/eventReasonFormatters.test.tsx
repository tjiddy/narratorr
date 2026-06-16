import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventReasonDetails } from './eventReasonFormatters';
import { qualityGateReasonSchema } from '../../shared/schemas.js';

/** A fully-populated, well-formed held_for_review reason blob. */
const fullReason = {
  action: 'held',
  mbPerHour: 60,
  existingMbPerHour: 40,
  narratorMatch: true,
  existingNarrator: 'John Smith',
  downloadNarrator: 'John Smith',
  durationDelta: 0.05,
  existingDuration: 7200,
  downloadedDuration: 7500,
  codec: 'AAC',
  channels: 2,
  existingCodec: 'MP3',
  existingChannels: 1,
  probeFailure: false,
  probeError: null,
  holdReasons: ['narrator_mismatch'],
};

/** A NULL_REASON-shaped blob: all keys present, T|null fields null. */
const nullReason = {
  action: 'held',
  mbPerHour: null,
  existingMbPerHour: null,
  narratorMatch: null,
  existingNarrator: null,
  downloadNarrator: null,
  durationDelta: null,
  existingDuration: null,
  downloadedDuration: null,
  codec: null,
  channels: null,
  existingCodec: null,
  existingChannels: null,
  probeFailure: false,
  probeError: null,
  holdReasons: [],
};

describe('EventReasonDetails', () => {
  const emptyMap = new Map<number, string>();

  it('renders grabbed details with key-value pairs', () => {
    render(<EventReasonDetails eventType="grabbed" reason={{ indexerId: 1, size: 1024, protocol: 'torrent' }} indexerMap={emptyMap} />);
    expect(screen.getByText('Indexer:')).toBeInTheDocument();
    expect(screen.getByText('Protocol:')).toBeInTheDocument();
    expect(screen.getByText('Size:')).toBeInTheDocument();
  });

  it('renders imported auto details with path, file count, and size', () => {
    render(<EventReasonDetails eventType="imported" reason={{ targetPath: '/lib/Author/Book', fileCount: 5, totalSize: 1048576 }} indexerMap={emptyMap} />);
    expect(screen.getByText('/lib/Author/Book')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('1 MB')).toBeInTheDocument();
  });

  it('renders imported manual details with path and mode', () => {
    render(<EventReasonDetails eventType="imported" reason={{ targetPath: '/lib/Author/Book', mode: 'copy' }} indexerMap={emptyMap} />);
    expect(screen.getByText('/lib/Author/Book')).toBeInTheDocument();
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('renders error details with icon and message text', () => {
    render(<EventReasonDetails eventType="import_failed" reason={{ error: 'disk full' }} indexerMap={emptyMap} />);
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('renders error details as generic fallback when no error field', () => {
    render(<EventReasonDetails eventType="import_failed" reason={{ code: 42, msg: 'oops' }} indexerMap={emptyMap} />);
    expect(screen.getByText('Code:')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders download_completed with progress', () => {
    render(<EventReasonDetails eventType="download_completed" reason={{ progress: 1 }} indexerMap={emptyMap} />);
    expect(screen.getByText('Progress:')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders generic fallback for unknown event types', () => {
    render(<EventReasonDetails eventType="some_future" reason={{ alpha: 'beta', count: 7 }} indexerMap={emptyMap} />);
    expect(screen.getByText('Alpha:')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText('Count:')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('omits null values in generic fallback', () => {
    render(<EventReasonDetails eventType="unknown" reason={{ visible: 'yes', hidden: null }} indexerMap={emptyMap} />);
    expect(screen.getByText('Visible:')).toBeInTheDocument();
    expect(screen.queryByText('Hidden:')).not.toBeInTheDocument();
  });

  it('renders download_failed with error text via error renderer', () => {
    render(<EventReasonDetails eventType="download_failed" reason={{ error: 'connection timeout' }} indexerMap={emptyMap} />);
    expect(screen.getByText('connection timeout')).toBeInTheDocument();
    // Must render as plain text error, not as a generic "Error:" key-value row
    expect(screen.queryByText('Error:')).not.toBeInTheDocument();
  });

  it('renders merge_failed with error text via error renderer', () => {
    render(<EventReasonDetails eventType="merge_failed" reason={{ error: 'ffmpeg not found' }} indexerMap={emptyMap} />);
    expect(screen.getByText('ffmpeg not found')).toBeInTheDocument();
    expect(screen.queryByText('Error:')).not.toBeInTheDocument();
  });

  it('renders grabbed details with resolved indexer name from map', () => {
    const indexerMap = new Map<number, string>([[5, 'MyAnonamouse']]);
    render(<EventReasonDetails eventType="grabbed" reason={{ indexerId: 5, size: 0, protocol: 'torrent' }} indexerMap={indexerMap} />);
    expect(screen.getByText('MyAnonamouse')).toBeInTheDocument();
    expect(screen.getByText('Torrent')).toBeInTheDocument();
    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('renders imported details with totalSize: 0 as "0 B"', () => {
    render(<EventReasonDetails eventType="imported" reason={{ targetPath: '/lib/Book', totalSize: 0, fileCount: 1 }} indexerMap={emptyMap} />);
    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('renders download_completed with fractional progress', () => {
    render(<EventReasonDetails eventType="download_completed" reason={{ progress: 0.756 }} indexerMap={emptyMap} />);
    expect(screen.getByText('76%')).toBeInTheDocument();
  });

  it('renders generic fallback with nested object as JSON string', () => {
    render(<EventReasonDetails eventType="custom" reason={{ nested: { foo: 'bar' } }} indexerMap={emptyMap} />);
    expect(screen.getByText('{"foo":"bar"}')).toBeInTheDocument();
  });

  // #464 — conditional Indexer row in GrabbedDetails
  it('grabbed — omits Indexer row when indexerId is absent', () => {
    render(<EventReasonDetails eventType="grabbed" reason={{ size: 1024, protocol: 'torrent' }} indexerMap={emptyMap} />);
    expect(screen.queryByText('Indexer:')).not.toBeInTheDocument();
    expect(screen.getByText('Protocol:')).toBeInTheDocument();
    expect(screen.getByText('Size:')).toBeInTheDocument();
  });

  it('grabbed — renders only Protocol when only protocol is present', () => {
    render(<EventReasonDetails eventType="grabbed" reason={{ protocol: 'torrent' }} indexerMap={emptyMap} />);
    expect(screen.queryByText('Indexer:')).not.toBeInTheDocument();
    expect(screen.queryByText('Size:')).not.toBeInTheDocument();
    expect(screen.getByText('Protocol:')).toBeInTheDocument();
    expect(screen.getByText('Torrent')).toBeInTheDocument();
  });

  it('grabbed — still renders all three rows when all fields present (regression)', () => {
    const indexerMap = new Map<number, string>([[1, 'TestIndexer']]);
    render(<EventReasonDetails eventType="grabbed" reason={{ indexerId: 1, size: 2048, protocol: 'usenet' }} indexerMap={indexerMap} />);
    expect(screen.getByText('Indexer:')).toBeInTheDocument();
    expect(screen.getByText('TestIndexer')).toBeInTheDocument();
    expect(screen.getByText('Protocol:')).toBeInTheDocument();
    expect(screen.getByText('Size:')).toBeInTheDocument();
  });

  // #1157 — grab_failed renders both release_title and error
  it('grab_failed — renders both release title and error message', () => {
    render(<EventReasonDetails eventType="grab_failed" reason={{ error: 'Connection refused', release_title: 'My.Book.MP3' }} indexerMap={emptyMap} />);
    expect(screen.getByText('Release:')).toBeInTheDocument();
    expect(screen.getByText('My.Book.MP3')).toBeInTheDocument();
    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  // #1528 — attribution_analysis renderer
  const okPartialReason = {
    outcome: 'ok',
    attributionPresent: true,
    confidence: 0.82,
    comparisonStatus: 'partial',
    expected: { title: 'The Way of Kings', authors: ['Brandon Sanderson'], narrators: ['Michael Kramer', 'Kate Reading'] },
    detected: { title: 'The Way of Kings', authors: ['Brandon Sanderson'], narrators: ['Michael Kramer'] },
    fields: {
      title: { status: 'match', expected: 'The Way of Kings', detected: 'The Way of Kings', reason: 'exact' },
      authors: { status: 'match', expected: ['Brandon Sanderson'], detected: ['Brandon Sanderson'], reason: 'ok' },
      narrators: { status: 'partial', expected: ['Michael Kramer', 'Kate Reading'], detected: ['Michael Kramer'], missingExpected: ['Kate Reading'], unexpectedDetected: [], reason: 'lead only' },
    },
  };

  it('attribution_analysis — shows per-field status, heard-vs-expected, and confidence', () => {
    render(<EventReasonDetails eventType="attribution_analysis" reason={okPartialReason} indexerMap={emptyMap} />);
    expect(screen.getByText('Confidence:')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
    // per-field rows
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Narrators')).toBeInTheDocument();
    expect(screen.getByText(/Kate Reading/)).toBeInTheDocument(); // expected narrators (joined)
    // partial is rendered neutrally (no destructive styling) — both the overall
    // and narrators pills read "Partial"
    const partialPills = screen.getAllByText('Partial');
    expect(partialPills.length).toBeGreaterThan(0);
    for (const pill of partialPills) {
      expect(pill.className).not.toMatch(/destructive/);
      expect(pill.className).toMatch(/muted/);
    }
  });

  it('attribution_analysis — attributionPresent:false renders as Unverified, not a mismatch', () => {
    render(<EventReasonDetails eventType="attribution_analysis" reason={{ outcome: 'ok', attributionPresent: false, confidence: 0.1, comparisonStatus: 'unknown', fields: null }} indexerMap={emptyMap} />);
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText('Mismatch')).not.toBeInTheDocument();
  });

  it('attribution_analysis — permanent_failure surfaces the message verbatim', () => {
    render(<EventReasonDetails eventType="attribution_analysis" reason={{ outcome: 'permanent_failure', status: 422, message: 'unprocessable audio: re-rip the file' }} indexerMap={emptyMap} />);
    expect(screen.getByText('unprocessable audio: re-rip the file')).toBeInTheDocument();
  });

  it('attribution_analysis — transient_failure shows a try-again message', () => {
    render(<EventReasonDetails eventType="attribution_analysis" reason={{ outcome: 'transient_failure', message: 'busy' }} indexerMap={emptyMap} />);
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
  });

  it('attribution_analysis — renders untrusted detected text as escaped string, not markup', () => {
    const html = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <EventReasonDetails
        eventType="attribution_analysis"
        reason={{ outcome: 'ok', attributionPresent: true, confidence: 0.5, comparisonStatus: 'mismatch', fields: { title: { status: 'mismatch', expected: 'Clean', detected: html, reason: 'x' }, authors: { status: 'unknown', expected: [], detected: [], reason: '' }, narrators: { status: 'unknown', expected: [], detected: [], reason: '' } } }}
        indexerMap={emptyMap}
      />,
    );
    // The string is shown as text, and no <img> element is created from it.
    expect(screen.getByText(html)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

// #1305 — held_for_review reason blob is schema-validated before the QualityComparisonPanel cast.
// Malformed/legacy blobs fall back to GenericDetails instead of rendering "NaN MB/hr" or throwing.
describe('EventReasonDetails — held_for_review schema gate (#1305)', () => {
  const emptyMap = new Map<number, string>();

  function renderHeld(reason: Record<string, unknown>) {
    return render(<EventReasonDetails eventType="held_for_review" reason={reason} indexerMap={emptyMap} />);
  }

  it('AC1: missing numeric keys → generic fallback, no panel, no NaN', () => {
    const { mbPerHour: _m, existingMbPerHour: _e, ...rest } = fullReason;
    const { container } = renderHeld(rest);
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
    // Generic fallback renders the remaining keys as key-value rows
    expect(screen.getByText('Action:')).toBeInTheDocument();
  });

  it('AC1/test2: missing holdReasons key → generic fallback, does not throw', () => {
    const { holdReasons: _h, ...rest } = fullReason;
    expect(() => renderHeld(rest)).not.toThrow();
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
    expect(screen.getByText('Action:')).toBeInTheDocument();
  });

  it('AC2: empty object → generic fallback (renders nothing), does not throw', () => {
    expect(() => renderHeld({})).not.toThrow();
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
  });

  it('AC1/test3: wrong-typed field → generic fallback, no panel, no NaN', () => {
    const { container } = renderHeld({ ...fullReason, mbPerHour: 'fast' });
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
  });

  it('AC6: holdReasons: null → generic fallback, does not throw, no panel crash', () => {
    expect(() => renderHeld({ ...nullReason, holdReasons: null })).not.toThrow();
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
  });

  it('AC6: probeFailure: null → generic fallback (non-null field rejects null)', () => {
    renderHeld({ ...nullReason, probeFailure: null });
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
  });

  it('AC6: action: null → generic fallback (non-null field rejects null)', () => {
    renderHeld({ ...nullReason, action: null });
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
  });

  it('AC3/AC5: present-but-null T|null fields → panel renders with dashes, not NaN', () => {
    const { container } = renderHeld(nullReason);
    expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
    const dashes = Array.from(container.querySelectorAll('*')).filter((el) => el.textContent === '—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('AC4: fully-populated well-formed blob renders the panel unchanged', () => {
    renderHeld(fullReason);
    expect(screen.getByText('Quality Comparison')).toBeInTheDocument();
    expect(screen.getByText('60 MB/hr')).toBeInTheDocument();
    expect(screen.getByText('40 MB/hr')).toBeInTheDocument();
    expect(screen.getByText('narrator mismatch')).toBeInTheDocument();
  });

  // #1362 — the held_for_review fallback path is the rider this issue fixes: failed-parse
  // legacy rows must render inside the standard generic-details container (they previously
  // dumped bare), and the parse failure must emit a debug-level signal (previously silent).
  it('#1362: failed parse renders the generic fallback inside the standard boxed container', () => {
    const { container } = renderHeld({ ...nullReason, holdReasons: null });
    const box = container.querySelector('.bg-muted\\/50');
    expect(box).not.toBeNull();
    expect(box?.className).toContain('mt-2');
    expect(box?.className).toContain('p-3');
    expect(box?.className).toContain('rounded-xl');
    expect(box?.className).toContain('border');
    // the generic dump of surviving keys renders inside the box
    expect(box?.textContent).toContain('Action');
  });

  it('#1362: parse failure emits a once-guarded console.warn carrying the Zod error', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHeld({ ...nullReason, holdReasons: null });
    expect(spy).toHaveBeenCalledTimes(1);
    const carriedZodError = spy.mock.calls.some((args) =>
      args.some((a) => a instanceof Error || (!!a && typeof a === 'object' && 'issues' in (a as object))),
    );
    expect(carriedZodError).toBe(true);
    spy.mockRestore();
  });

  it('#1362: the once-guard does not re-fire across re-renders of the same card', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = { ...nullReason, holdReasons: null };
    const { rerender } = render(
      <EventReasonDetails eventType="held_for_review" reason={malformed} indexerMap={emptyMap} />,
    );
    rerender(<EventReasonDetails eventType="held_for_review" reason={malformed} indexerMap={emptyMap} />);
    rerender(<EventReasonDetails eventType="held_for_review" reason={malformed} indexerMap={emptyMap} />);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('#1362: a well-formed blob does NOT emit a console.warn signal', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHeld(fullReason);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('AC1: legacy blob missing several keys (the QualityComparisonPanel legacy case) falls back', () => {
    // Mirrors the legacy-shaped blob from QualityComparisonPanel.test.tsx that
    // is missing existingDuration/downloadedDuration/existingCodec/existingChannels.
    const legacy = {
      action: 'held',
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
    };
    renderHeld(legacy);
    expect(screen.queryByText('Quality Comparison')).not.toBeInTheDocument();
    expect(screen.getByText('Action:')).toBeInTheDocument();
  });
});

// #1305 — direct schema-gate assertions (fast, render-independent)
describe('qualityGateReasonSchema (#1305)', () => {
  it('accepts a NULL_REASON-shaped blob', () => {
    expect(qualityGateReasonSchema.safeParse(nullReason).success).toBe(true);
  });

  it('accepts a fully-populated blob', () => {
    expect(qualityGateReasonSchema.safeParse(fullReason).success).toBe(true);
  });

  it('rejects a blob missing a key', () => {
    const { mbPerHour: _m, ...missing } = fullReason;
    expect(qualityGateReasonSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects null for the non-null holdReasons field', () => {
    expect(qualityGateReasonSchema.safeParse({ ...nullReason, holdReasons: null }).success).toBe(false);
  });

  it('rejects null for the non-null probeFailure field', () => {
    expect(qualityGateReasonSchema.safeParse({ ...nullReason, probeFailure: null }).success).toBe(false);
  });

  it('rejects null for the non-null action field', () => {
    expect(qualityGateReasonSchema.safeParse({ ...nullReason, action: null }).success).toBe(false);
  });

  it('tolerates extra keys (strip), keeping known fields', () => {
    const result = qualityGateReasonSchema.safeParse({ ...nullReason, futureField: 'x' });
    expect(result.success).toBe(true);
    if (result.success) expect('futureField' in result.data).toBe(false);
  });
});
