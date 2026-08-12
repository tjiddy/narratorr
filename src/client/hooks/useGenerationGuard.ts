import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

/** Stamped into `onMutate` and re-checked in the settlement callbacks. */
export interface GenerationContext {
  gen: number;
}

export interface GenerationGuard {
  /** Reads the generation at call time — a render-time snapshot would miss a retire mid-flight. */
  capture: () => GenerationContext;
  isLive: (context: GenerationContext | undefined) => boolean;
  retire: () => void;
}

/**
 * Monotonic lifecycle generation for react-query mutation callbacks, which fire even after the
 * component that called `mutate()` unmounts. Stamp `onMutate` with `capture()`, then gate only the
 * lifecycle-local half of each callback (toast, setState, navigation) on `isLive(context)`; shared
 * cache reconciliation stays unconditional, because the server changed regardless of this lifecycle.
 *
 * Three contracts a call site depends on:
 *
 * - **An absent context counts as live.** `isLive(undefined)` is `true`, deliberately — react-query
 *   hands `onError` an `undefined` context when `onMutate` never ran, and that error still belongs
 *   to a live lifecycle. Writing the check as `context?.gen === current` would swallow it instead.
 * - **The retire runs on the layout seam**, never a passive `useEffect` cleanup: layout cleanup
 *   completes before the replacing instance is interactive, so a keyed remount leaves no window in
 *   which a stale callback can act on the new instance.
 * - **The advance is in the cleanup, not the setup.** query-core dispatches `pending` before it
 *   awaits `onMutate`, so a per-commit advance still agrees at settlement in the common case and
 *   diverges only when a commit lands mid-flight — silently swallowing the effect there.
 *
 * `retire` is idempotent with respect to teardown: a caller that wires it into its own layout
 * cleanup retires alongside this hook's unmount cleanup, which is harmless — the counter only ever
 * moves forward and nothing captures after teardown.
 */
export function useGenerationGuard(): GenerationGuard {
  const genRef = useRef(0);

  const capture = useCallback((): GenerationContext => ({ gen: genRef.current }), []);
  const isLive = useCallback(
    (context: GenerationContext | undefined): boolean => context === undefined || context.gen === genRef.current,
    [],
  );
  const retire = useCallback(() => { genRef.current += 1; }, []);

  useLayoutEffect(() => retire, [retire]);

  return useMemo(() => ({ capture, isLive, retire }), [capture, isLive, retire]);
}
