import { useEffect, useState } from 'react';
import type { ZodTypeAny } from 'zod';

/**
 * Validate a DTO with an EFFECT-KEYED warn (#1894). Per this repo's lint rules a
 * validation-failure log from a component must be a `console.warn` inside a
 * `useEffect` keyed on the data identity (not a render-body `console.debug`, and
 * not a `useRef` once-guard read during render) — see the
 * `render-body-logging-lint-constraints` learning. Returns whether the current
 * `data` is valid so the caller can render an error state on a malformed payload.
 */
export function useDtoValid(schema: ZodTypeAny, data: unknown, label: string): boolean {
  const [valid, setValid] = useState(true);
  useEffect(() => {
    if (data == null) {
      setValid(true);
      return;
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      console.warn(`Malformed ${label} DTO — rendering error state`, result.error);
      setValid(false);
    } else {
      setValid(true);
    }
  }, [schema, data, label]);
  return valid;
}
