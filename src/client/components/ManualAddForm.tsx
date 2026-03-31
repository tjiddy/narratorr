import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FormField } from '@/components/settings/FormField';
import { PlusIcon } from '@/components/icons';

const manualAddSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  author: z.string().trim().optional(),
  seriesName: z.string().trim().optional(),
  seriesPosition: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number().optional(),
  ),
});

type ManualAddFormData = z.infer<typeof manualAddSchema>;

export function ManualAddForm({ defaultTitle, onSuccess }: {
  defaultTitle?: string;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();

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
        seriesName: data.seriesName || undefined,
        seriesPosition: data.seriesPosition,
        searchImmediately: true,
      }),
    onSuccess: (_result, data) => {
      toast.success(`Added '${data.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      reset();
      onSuccess?.();
    },
    onError: (err: Error) => {
      toast.error(`Failed to add book: ${err.message}`);
    },
  });

  return (
    <form
      onSubmit={handleSubmit((data) => addMutation.mutate(data))}
      className="glass-card rounded-2xl p-6 max-w-lg mx-auto space-y-4"
    >
      <h3 className="font-display text-lg font-semibold text-center">Add manually</h3>

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
          type="number"
          placeholder="#"
          min={0}
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
