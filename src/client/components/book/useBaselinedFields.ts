import { useEffect, useRef, useState } from 'react';
import type { DisplayedFields } from '@/pages/book/helpers.js';

/** The Edit Metadata inputs whose value AND diff baseline come from `DisplayedFields`. */
export interface BaselinedFieldValues {
  subtitle: string;
  seriesName: string;
  seriesPosition: string;
  description: string;
  publishedDate: string;
  genres: string;
  publisher: string;
}

export type BaselinedFieldKey = keyof BaselinedFieldValues;

/** Render a resolved baseline as the string each input holds. */
export function baselineToInputs(baseline: DisplayedFields): BaselinedFieldValues {
  return {
    subtitle: baseline.subtitle ?? '',
    seriesName: baseline.seriesName ?? '',
    seriesPosition: baseline.seriesPosition?.toString() ?? '',
    description: baseline.description ?? '',
    publishedDate: baseline.publishedDate ?? '',
    genres: (baseline.genres ?? []).join(', '),
    publisher: baseline.publisher ?? '',
  };
}

const KEYS: readonly BaselinedFieldKey[] = [
  'subtitle', 'seriesName', 'seriesPosition', 'description', 'publishedDate', 'genres', 'publisher',
];

/**
 * Hold the modal's baseline-driven inputs, and keep them coherent with a baseline
 * that can settle AFTER mount (#2069 F22).
 *
 * `BookPage` renders `BookDetails` as soon as the LIBRARY query resolves, while
 * provider metadata is a separate query. A plain `useState(initial)` therefore
 * freezes whatever baseline existed at open time, so opening Edit before metadata
 * arrives would leave both the input and the diff baseline on the pre-provider
 * value — and a provider-only clear stays inexpressible until the modal is closed
 * and reopened, which is exactly the case AC25 exists to fix.
 *
 * The sync is DIRTY-AWARE: a field whose current input still equals the PREVIOUS
 * baseline's rendering is untouched and adopts the new one; a field the operator
 * has typed into is left exactly as they left it. The effect keys off the rendered
 * baseline's value (a JSON string), not object identity, so a caller rebuilding
 * `DisplayedFields` each render does not re-trigger it.
 */
export function useBaselinedFields(baseline: DisplayedFields) {
  const inputs = baselineToInputs(baseline);
  const key = JSON.stringify(inputs);

  const [values, setValues] = useState<BaselinedFieldValues>(inputs);
  const previous = useRef({ key, inputs });

  useEffect(() => {
    const prior = previous.current;
    if (prior.key === key) return;
    previous.current = { key, inputs };
    setValues((current) => {
      const merged = { ...current };
      let changed = false;
      for (const field of KEYS) {
        if (current[field] === prior.inputs[field] && inputs[field] !== current[field]) {
          merged[field] = inputs[field];
          changed = true;
        }
      }
      return changed ? merged : current;
    });
    // `inputs` is derived from `key` — depending on it too would fire on every
    // render, since the caller builds a fresh object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setField = (field: BaselinedFieldKey, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  return { values, setField };
}
