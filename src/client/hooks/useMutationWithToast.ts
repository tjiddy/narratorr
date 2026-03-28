import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query';
import { toast } from 'sonner';

type QueryKey = readonly unknown[];

export interface UseMutationWithToastConfig<TData, TError, TVariables> {
  mutationFn: NonNullable<UseMutationOptions<TData, TError, TVariables>['mutationFn']>;
  queryKey: QueryKey | QueryKey[];
  successMessage: string;
  errorMessage: string | ((error: unknown) => string);
  onSuccess?: (data: TData, variables: TVariables, context: unknown) => void;
  onError?: (error: unknown, variables: TVariables, context: unknown) => void;
}

export function useMutationWithToast<TData = unknown, TError = Error, TVariables = void>({
  mutationFn,
  queryKey,
  successMessage,
  errorMessage,
  onSuccess,
  onError,
}: UseMutationWithToastConfig<TData, TError, TVariables>) {
  const queryClient = useQueryClient();

  const keys: QueryKey[] = Array.isArray(queryKey[0]) ? (queryKey as QueryKey[]) : [queryKey as QueryKey];

  return useMutation<TData, TError, TVariables>({
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
