import { describe, it, expect, beforeEach } from 'vitest';
import { StrictMode, useLayoutEffect, useRef, type ReactNode } from 'react';
import { renderHook, render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useGenerationGuard, type GenerationContext, type GenerationGuard } from './useGenerationGuard';

const PROBE_KEY = ['generation-guard-probe'];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useGenerationGuard — capture/liveness contract', () => {
  it('T1: a context captured while mounted is live, and generation 0 is not special-cased', () => {
    const { result, rerender } = renderHook(() => useGenerationGuard());

    const first = result.current.capture();
    expect(first.gen).toBe(0);
    expect(result.current.isLive(first)).toBe(true);

    rerender();
    expect(result.current.isLive(first)).toBe(true);
  });

  it('T2: retire invalidates prior captures but not later ones', () => {
    const { result } = renderHook(() => useGenerationGuard());

    const before = result.current.capture();
    result.current.retire();
    const after = result.current.capture();

    expect(result.current.isLive(before)).toBe(false);
    expect(result.current.isLive(after)).toBe(true);
  });

  it('T3: an absent context counts as live before and after a retire; a future generation does not', () => {
    const { result } = renderHook(() => useGenerationGuard());

    expect(result.current.isLive(undefined)).toBe(true);
    result.current.retire();
    expect(result.current.isLive(undefined)).toBe(true);

    // Equality, not "less than": a context the guard has never issued is stale in both directions.
    expect(result.current.isLive({ gen: 99 })).toBe(false);
  });

  it('T4: capture, isLive and retire keep identity across re-renders and prop changes', () => {
    const { result, rerender } = renderHook((_props: { n: number }) => useGenerationGuard(), {
      initialProps: { n: 0 },
    });
    const first = result.current;

    rerender({ n: 0 });
    rerender({ n: 1 });
    rerender({ n: 2 });

    expect(result.current.capture).toBe(first.capture);
    expect(result.current.isLive).toBe(first.isLive);
    expect(result.current.retire).toBe(first.retire);
  });

  it('T5: ordinary commits do not advance the generation', () => {
    const client = makeClient();
    let renders = 0;
    const { result, rerender } = renderHook(
      (_props: { n: number }) => {
        renders += 1;
        const guard = useGenerationGuard();
        useQuery({ queryKey: PROBE_KEY, queryFn: () => Promise.resolve('v0'), staleTime: Infinity });
        return guard;
      },
      { wrapper: wrapperFor(client), initialProps: { n: 0 } },
    );

    const captured = result.current.capture();
    const rendersAtCapture = renders;

    rerender({ n: 1 });
    rerender({ n: 2 });
    rerender({ n: 3 });
    // A cache write the mounted hook observes is a commit this hook did not ask for.
    act(() => { client.setQueryData(PROBE_KEY, 'v1'); });

    expect(renders).toBeGreaterThan(rendersAtCapture);
    expect(result.current.isLive(captured)).toBe(true);
  });

  it('T6: unmounting the host retires the generation', () => {
    const { result, unmount } = renderHook(() => useGenerationGuard());

    const captured = result.current.capture();
    expect(result.current.isLive(captured)).toBe(true);

    unmount();

    expect(result.current.isLive(captured)).toBe(false);
  });

  it('T7: under StrictMode a context captured after mount settles is live', () => {
    const { result, rerender } = renderHook(() => useGenerationGuard(), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });

    // React 19 dev-mode mounts, unmounts and remounts; the retire that pass fires must not
    // strand the generation a subsequent mutate() captures.
    const captured = result.current.capture();
    rerender();

    expect(result.current.isLive(captured)).toBe(true);
  });

  it('T9: one guard serves several mutations, and each retire advances exactly one step', () => {
    const { result } = renderHook(() => useGenerationGuard());

    const deleteCtx = result.current.capture();
    const clearCtx = result.current.capture();
    result.current.retire();

    expect(result.current.isLive(deleteCtx)).toBe(false);
    expect(result.current.isLive(clearCtx)).toBe(false);

    const afterOne = result.current.capture();
    expect(afterOne.gen).toBe(1);

    result.current.retire();
    result.current.retire();
    const afterThree = result.current.capture();

    expect(afterThree.gen).toBe(3);
    expect(result.current.isLive(afterOne)).toBe(false);
    expect(result.current.isLive(afterThree)).toBe(true);
  });
});

/**
 * T8 — the retire must land on the layout seam. RTL's `act` flushes passive effects before
 * returning, so settling a promise after the swap cannot tell the two seams apart. The host's
 * OWN layout cleanup is the pre-passive observation point: React runs every layout cleanup in
 * hook-declaration order before any layout setup, so the guard's cleanup (declared first, inside
 * the hook) has already retired by the time the host's reads it — while a passive cleanup, or an
 * advance moved into effect setup, has not.
 */
describe('useGenerationGuard — layout seam', () => {
  const marks: string[] = [];
  const seam: { guard: GenerationGuard | null; captured: GenerationContext | null } = {
    guard: null,
    captured: null,
  };

  function SeamHost() {
    const guard = useGenerationGuard();
    seam.guard = guard;
    const observed = useRef(guard);
    observed.current = guard;
    useLayoutEffect(
      () => () => {
        marks.push(observed.current.isLive(seam.captured!) ? 'A-still-live' : 'A-teardown');
      },
      [],
    );
    return <div>A</div>;
  }

  function InteractiveProbe() {
    useLayoutEffect(() => { marks.push('B-interactive'); }, []);
    return <div>B</div>;
  }

  function SeamTree({ phase }: { phase: 'a' | 'b' }) {
    return phase === 'a' ? <SeamHost key="a" /> : <InteractiveProbe key="b" />;
  }

  beforeEach(() => {
    marks.length = 0;
    seam.guard = null;
    seam.captured = null;
  });

  it('T8: the generation is retired before the replacing sibling becomes interactive', () => {
    const { rerender } = render(<SeamTree phase="a" />);
    seam.captured = seam.guard!.capture();
    marks.length = 0;

    rerender(<SeamTree phase="b" />);

    expect(marks).toEqual(['A-teardown', 'B-interactive']);
  });
});
