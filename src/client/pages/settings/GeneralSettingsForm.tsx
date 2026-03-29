import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ClockIcon, TerminalIcon } from '@/components/icons';
import { logLevelSchema, DEFAULT_SETTINGS } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const generalFormSchema = z.object({
  logLevel: logLevelSchema,
  housekeepingRetentionDays: z.number().int().min(1).max(365),
  recycleRetentionDays: z.number().int().min(0).max(365),
});

type GeneralFormData = z.infer<typeof generalFormSchema>;

export function GeneralSettingsForm() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<GeneralFormData>({
    defaultValues: {
      logLevel: DEFAULT_SETTINGS.general.logLevel,
      housekeepingRetentionDays: DEFAULT_SETTINGS.general.housekeepingRetentionDays,
      recycleRetentionDays: DEFAULT_SETTINGS.general.recycleRetentionDays,
    },
    resolver: zodResolver(generalFormSchema),
  });

  useEffect(() => {
    if (settings?.general && !isDirty) {
      reset({
        logLevel: settings.general.logLevel,
        housekeepingRetentionDays: settings.general.housekeepingRetentionDays,
        recycleRetentionDays: settings.general.recycleRetentionDays,
      });
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: GeneralFormData) =>
      api.updateSettings({ general: data }),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('General settings saved');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  return (
    <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-8">
      <SettingsSection
        icon={<ClockIcon className="w-5 h-5 text-primary" />}
        title="Housekeeping"
        description="Automatic database maintenance and cleanup"
      >
        <div>
          <label htmlFor="housekeepingRetentionDays" className="block text-sm font-medium mb-2">Event History Retention (days)</label>
          <input
            id="housekeepingRetentionDays"
            type="number"
            min={1}
            max={365}
            {...register('housekeepingRetentionDays', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
              errors.housekeepingRetentionDays ? 'border-destructive' : 'border-border'
            }`}
          />
          {errors.housekeepingRetentionDays && (
            <p className="text-sm text-destructive mt-1">{errors.housekeepingRetentionDays.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Events older than this many days are automatically pruned during the weekly housekeeping job. Valid range: 1–365 days.
          </p>
        </div>
        <div>
          <label htmlFor="recycleRetentionDays" className="block text-sm font-medium mb-2">Recycling Bin Retention (days)</label>
          <input
            id="recycleRetentionDays"
            type="number"
            min={0}
            max={365}
            {...register('recycleRetentionDays', { valueAsNumber: true })}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
              errors.recycleRetentionDays ? 'border-destructive' : 'border-border'
            }`}
          />
          {errors.recycleRetentionDays && (
            <p className="text-sm text-destructive mt-1">{errors.recycleRetentionDays.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Deleted books are permanently removed after this many days. Set to 0 to disable automatic cleanup. Valid range: 0–365 days.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<TerminalIcon className="w-5 h-5 text-primary" />}
        title="Logging"
        description="Control server log verbosity"
      >
        <div>
          <label htmlFor="logLevel" className="block text-sm font-medium mb-2">Log Level</label>
          <select
            id="logLevel"
            {...register('logLevel')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
          >
            {logLevelSchema.options.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground mt-2">
            Set to Debug for detailed diagnostic output, or Error to reduce noise
          </p>
        </div>
        {isDirty && (
          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </SettingsSection>
    </form>
  );
}
