import { useEffect, useRef, useState } from 'react';
import type { DisplayedFields } from '@/pages/book/helpers.js';

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
 * Resyncs untouched inputs when provider metadata settles after modal mount.
 * Values diverging from the prior rendered baseline are dirty and remain unchanged.
 * Key by rendered values because callers rebuild `DisplayedFields` each render.
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
    // inputs is reconstructed every render but fully represented by key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setField = (field: BaselinedFieldKey, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  return { values, setField };
}
