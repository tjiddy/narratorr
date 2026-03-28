import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

type QueryKey = readonly unknown[];

export interface UseMutationWithToastConfig<TInput, TOutput> {
  mutationFn: (input: TInput) => Promise<TOutput>;
  queryKey: QueryKey | QueryKey[];
  successMessage: string;
  errorMessage: string | ((error: unknown) => string);
  onSuccess?: (data: TOutput, variables: TInput, context: unknown) => void;
  onError?: (error: unknown, variables: TInput, context: unknown) => void;
}

export function useMutationWithToast<TInput, TOutput>({
  mutationFn,
  queryKey,
  successMessage,
  errorMessage,
  onSuccess,
  onError,
}: UseMutationWithToastConfig<TInput, TOutput>) {
  const queryClient = useQueryClient();

  const keys: QueryKey[] = Array.isArray(queryKey[0]) ? (queryKey as QueryKey[]) : [queryKey as QueryKey];

  return useMutation({
    mutationFn,
    onSuccess: (data, variables, context) => {
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success(successMessage);
      onSuccess?.(data, variables, context);
    },
    onError: (error, variables, context) => {
      const message = typeof errorMessage === 'function' ? errorMessage(error) : errorMessage;
      toast.error(message);
      onError?.(error, variables, context);
    },
  });
}
