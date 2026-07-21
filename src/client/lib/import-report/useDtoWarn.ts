import { useEffect, useMemo } from 'react';
import type { ZodTypeAny } from 'zod';

/**
 * Validate a DTO with an EFFECT-KEYED warn (#1894). Per this repo's lint rules a
 * validation-failure log from a component must be a `console.warn` inside a
 * `useEffect` keyed on the data identity (not a render-body `console.debug`, and
 * not a `useRef` once-guard read during render) — see the
 * `render-body-logging-lint-constraints` learning. The `safeParse` itself is pure,
 * so it runs in render (`useMemo`); only the warn lives in the effect. Returns
 * whether the current `data` is valid so the caller can render an error state.
 */
export function useDtoValid(schema: ZodTypeAny, data: unknown, label: string): boolean {
  const result = useMemo(
    () => (data == null ? { success: true as const } : schema.safeParse(data)),
    [schema, data],
  );
  useEffect(() => {
    if (!result.success) {
      console.warn(`Malformed ${label} DTO — rendering error state`, result.error);
    }
  }, [result, label]);
  return result.success;
}
