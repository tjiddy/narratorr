import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FormField } from '@/components/settings/FormField';
import { PlusIcon } from '@/components/icons';
import { getErrorMessage } from '@/lib/error-message.js';

const manualAddSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  author: z.string().trim().optional(),
  seriesName: z.string().trim().optional(),
  seriesPosition: z.string().trim().optional().refine(
    (v) => !v || !Number.isNaN(Number(v)),
    { message: 'Must be a number' },
  ),
});

type ManualAddFormData = z.infer<typeof manualAddSchema>;

export function ManualAddForm({ defaultTitle, onSuccess, onPendingChange }: {
  defaultTitle?: string | undefined;
  onSuccess?: (() => void) | undefined;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });
  const qualityDefaults = settings?.quality;

  const { register, handleSubmit, reset, formState: { errors } } = useForm<ManualAddFormData>({
    resolver: zodResolver(manualAddSchema),
    defaultValues: {
      title: defaultTitle ?? '',
      author: '',
      seriesName: '',
    },
  });

  const addMutation = useMutation({
    mutationFn: (data: ManualAddFormData) =>
      api.addBook({
        title: data.title,
        authors: data.author ? [{ name: data.author }] : [],
        ...(data.seriesName && { seriesName: data.seriesName }),
        ...(data.seriesPosition && { seriesPosition: Number(data.seriesPosition) }),
        searchImmediately: qualityDefaults?.searchImmediately ?? false,
        monitorForUpgrades: qualityDefaults?.monitorForUpgrades ?? false,
      }),
    onSuccess: (_result, data) => {
      toast.success(`Added '${data.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      reset();
      onSuccess?.();
    },
    onError: (err: Error) => {
      toast.error(`Failed to add book: ${getErrorMessage(err)}`);
    },
  });

  useEffect(() => {
    onPendingChange?.(addMutation.isPending);
  }, [addMutation.isPending, onPendingChange]);

  return (
    <form
      onSubmit={handleSubmit((data) => addMutation.mutate(data))}
      className="glass-card rounded-2xl p-6 max-w-lg mx-auto space-y-4"
    >
      <h3 id="manual-add-form-title" className="font-display text-lg font-semibold text-center">Add manually</h3>

      <FormField
        id="manual-title"
        label="Title"
        registration={register('title')}
        error={errors.title}
        placeholder="Book title"
      />

      <FormField
        id="manual-author"
        label="Author"
        registration={register('author')}
        error={errors.author}
        placeholder="Optional"
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          id="manual-series"
          label="Series"
          registration={register('seriesName')}
          error={errors.seriesName}
          placeholder="Optional"
        />
        <FormField
          id="manual-position"
          label="Position"
          registration={register('seriesPosition')}
          error={errors.seriesPosition}
          placeholder="#"
        />
      </div>

      <button
        type="submit"
        disabled={addMutation.isPending}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground rounded-xl font-medium transition-all hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <PlusIcon className="w-4 h-4" />
        {addMutation.isPending ? 'Adding...' : 'Add Book'}
      </button>
    </form>
  );
}
