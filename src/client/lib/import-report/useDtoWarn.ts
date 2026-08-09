import { useEffect, useMemo } from 'react';
import type { ZodTypeAny } from 'zod';

/** Validates during render but warns from an effect to satisfy render-body logging constraints. */
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
