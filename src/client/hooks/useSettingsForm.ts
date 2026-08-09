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
import type { AppSettings, UpdateSettingsInput } from '@shared/schemas.js';

export interface UseSettingsFormConfig<T extends Record<string, unknown>> {
  // Explicit input T keeps zodResolver compatible; z.ZodType<T> defaults input to unknown.
  schema: z.ZodType<T, T>;
  defaultValues: T;
  select: (settings: AppSettings) => T;
  toPayload: (data: T) => Partial<UpdateSettingsInput>;
  successMessage: string;
  /** Unsaved-changes label; share the card title because success messages are not unique. */
  label: string;
}

export interface UseSettingsFormReturn<T extends Record<string, unknown>> {
  form: UseFormReturn<T>;
  mutation: ReturnType<typeof useMutation<AppSettings, Error, T, { submittedRaw: T }>>;
  onSubmit: (data: T) => void;
}

// Both values come from one form, so JSON key order is stable.
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
    // Snapshot deeply because RHF shares nested references with edits made during the request.
    onMutate: () => ({ submittedRaw: structuredClone(form.getValues()) }),
    // onMutate context is TanStack Query's third onSuccess argument.
    onSuccess: (_result, submittedData, context) => {
      const currentRaw = form.getValues();
      // Compare raw snapshots; resolver output may differ without a user edit.
      const drifted = !valuesEqual(currentRaw, context.submittedRaw);
      if (drifted) {
        // The saved payload becomes baseline while the later draft remains dirty.
        reset(submittedData as DefaultValues<T>);
        reset(currentRaw as DefaultValues<T>, { keepDefaultValues: true });
      } else {
        reset(submittedData as DefaultValues<T>);
      }
      // Update before invalidation so refetch hydration cannot overwrite a preserved draft.
      isDirtyRef.current = drifted;
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success(successMessage);
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
    },
  });

  // Saving counts as dirty so navigation cannot dismiss an in-flight card.
  useTrackedForm({ isDirty, isPending: mutation.isPending, label });

  const onSubmit = (data: T) => {
    mutation.mutate(data);
  };

  return { form, mutation, onSubmit };
}
