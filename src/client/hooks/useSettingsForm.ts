import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type UseFormReturn, type DefaultValues, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { useTrackedForm } from '@/hooks/dirty-forms.js';
import type { AppSettings, UpdateSettingsInput } from '../../shared/schemas.js';

export interface UseSettingsFormConfig<T extends Record<string, unknown>> {
  // z.ZodType<T, T> is intentional: z.ZodType<T> sets _input to unknown, which conflicts
  // with zodResolver's FieldValues constraint. The second T aligns _input with the output type.
  schema: z.ZodType<T, T>;
  defaultValues: T;
  select: (settings: AppSettings) => T;
  toPayload: (data: T) => Partial<UpdateSettingsInput>;
  successMessage: string;
  /**
   * Human-readable card name shown by the unsaved-changes guard. Keep it in sync
   * with the sibling `<SettingsSection title>` by sharing one per-card constant —
   * the success message is not a reliable card name (some cards share one).
   */
  label: string;
}

export interface UseSettingsFormReturn<T extends Record<string, unknown>> {
  form: UseFormReturn<T>;
  mutation: ReturnType<typeof useMutation<AppSettings, Error, T, { submittedRaw: T }>>;
  onSubmit: (data: T) => void;
}

/**
 * Deterministic compare of two raw form-value objects. Both operands originate from
 * `form.getValues()` on the same form, so they share shape and key order and a stable
 * serialize is fully deterministic — no external deep-equal dependency is needed.
 */
function valuesEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useSettingsForm<T extends Record<string, unknown>>({
  schema,
  defaultValues,
  select,
  toPayload,
  successMessage,
  label,
}: UseSettingsFormConfig<T>): UseSettingsFormReturn<T> {
  const queryClient = useQueryClient();
  const selectRef = useRef(select);
  const toPayloadRef = useRef(toPayload);

  useEffect(() => {
    selectRef.current = select;
    toPayloadRef.current = toPayload;
  });

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const form = useForm<T>({
    defaultValues: defaultValues as DefaultValues<T>,
    resolver: zodResolver(schema) as Resolver<T>,
  });

  const { reset, formState: { isDirty } } = form;
  const isDirtyRef = useRef(isDirty);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    if (settings && !isDirtyRef.current) {
      reset(selectRef.current(settings) as DefaultValues<T>);
    }
  }, [settings, reset]);

  const mutation = useMutation<AppSettings, Error, T, { submittedRaw: T }>({
    mutationFn: (data: T) => api.updateSettings(toPayloadRef.current(data)),
    // Deep-clone the raw submit-time snapshot. getValues() spreads only the top level
    // of _formValues, so nested references stay shared with the live form; a nested-path
    // edit during flight would otherwise mutate the captured snapshot and defeat the
    // compare. Settings values are JSON-safe, so structuredClone is safe here.
    onMutate: () => ({ submittedRaw: structuredClone(form.getValues()) }),
    // context (the onMutate result) is the third argument in @tanstack/query-core.
    onSuccess: (_result, submittedData, context) => {
      const currentRaw = form.getValues();
      // "drifted" = did the RAW value change after submit? Compared raw-vs-raw, never
      // against the resolver-parsed submittedData (which diverges for transforming
      // schemas even with no edit) and never via RHF's dirty-vs-old-default check.
      const drifted = !valuesEqual(currentRaw, context.submittedRaw);
      if (drifted) {
        // Rebaseline the default to the saved payload, then restore the raw draft while
        // keeping that new baseline so isDirty re-derives as currentRaw !== submittedData.
        reset(submittedData as DefaultValues<T>);
        reset(currentRaw as DefaultValues<T>, { keepDefaultValues: true });
      } else {
        reset(submittedData as DefaultValues<T>);
      }
      // Synchronous guard so the hydrate effect can't observe a stale-clean ref and
      // clobber the preserved draft when the settings refetch resolves.
      isDirtyRef.current = drifted;
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success(successMessage);
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
    },
  });

  // Register with the dirty-form guard so navigating away with unsaved edits (or
  // a save in flight) is intercepted. Covers every useSettingsForm card at once.
  useTrackedForm({ isDirty, isPending: mutation.isPending, label });

  const onSubmit = (data: T) => {
    mutation.mutate(data);
  };

  return { form, mutation, onSubmit };
}
