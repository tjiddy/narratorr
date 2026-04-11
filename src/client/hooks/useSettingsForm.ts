import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type UseFormReturn, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import type { AppSettings, UpdateSettingsInput } from '../../../shared/schemas.js';

export interface UseSettingsFormConfig<T extends Record<string, unknown>> {
  schema: z.ZodType<T>;
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
  selectRef.current = select;
  const toPayloadRef = useRef(toPayload);
  toPayloadRef.current = toPayload;

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const form = useForm<T>({
    defaultValues: defaultValues as DefaultValues<T>,
    resolver: zodResolver(schema),
  });

  const { reset, formState: { isDirty } } = form;

  useEffect(() => {
    if (settings && !isDirty) {
      reset(selectRef.current(settings) as DefaultValues<T>);
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation<AppSettings, Error, T>({
    mutationFn: (data: T) => api.updateSettings(toPayloadRef.current(data)),
    onSuccess: (_result, submittedData) => {
      reset(submittedData as DefaultValues<T>);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success(successMessage);
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, 'Failed to save settings'));
    },
  });

  const onSubmit = (data: T) => {
    mutation.mutate(data);
  };

  return { form, mutation, onSubmit };
}
