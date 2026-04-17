import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type UseFormReturn, type DefaultValues, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import type { AppSettings, UpdateSettingsInput } from '../../shared/schemas.js';

export interface UseSettingsFormConfig<T extends Record<string, unknown>> {
  // z.ZodType<T, T> is intentional: z.ZodType<T> sets _input to unknown, which conflicts
  // with zodResolver's FieldValues constraint. The second T aligns _input with the output type.
  // See .narratorr/cl/learnings/zodresolver-generic-type-mismatch.md
  schema: z.ZodType<T, T>;
  defaultValues: T;
  select: (settings: AppSettings) => T;
  toPayload: (data: T) => Partial<UpdateSettingsInput>;
  successMessage: string;
}

export interface UseSettingsFormReturn<T extends Record<string, unknown>> {
  form: UseFormReturn<T>;
  mutation: ReturnType<typeof useMutation<AppSettings, Error, T>>;
  onSubmit: (data: T) => void;
}

export function useSettingsForm<T extends Record<string, unknown>>({
  schema,
  defaultValues,
  select,
  toPayload,
  successMessage,
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

  const mutation = useMutation<AppSettings, Error, T>({
    mutationFn: (data: T) => api.updateSettings(toPayloadRef.current(data)),
    onSuccess: (_result, submittedData) => {
      reset(submittedData as DefaultValues<T>);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success(successMessage);
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
    },
  });

  const onSubmit = (data: T) => {
    mutation.mutate(data);
  };

  return { form, mutation, onSubmit };
}
