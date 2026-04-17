import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TaskMetadata } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { LoadingSpinner, ClockIcon, ZapIcon } from '@/components/icons';
import { SettingsSection } from './SettingsSection';

function formatTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function TaskRow({ task }: { task: TaskMetadata }) {
  const queryClient = useQueryClient();
  const [runningName, setRunningName] = useState<string | null>(null);

  const runMutation = useMutation({
    mutationFn: (name: string) => api.runSystemTask(name),
    onSuccess: () => {
      toast.success(`Task "${task.name}" completed`);
      queryClient.invalidateQueries({ queryKey: queryKeys.systemTasks() });
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
      queryClient.invalidateQueries({ queryKey: queryKeys.systemTasks() });
    },
    onSettled: () => setRunningName(null),
  });

  const isRunning = task.running || runningName === task.name;

  return (
    <tr className="border-b border-border/50 last:border-0">
      <td className="py-2.5 pr-4 text-sm font-medium">{task.name}</td>
      <td className="py-2.5 pr-4 text-sm text-muted-foreground">{formatTime(task.lastRun)}</td>
      <td className="py-2.5 pr-4 text-sm text-muted-foreground">{formatTime(task.nextRun)}</td>
      <td className="py-2.5 pr-4 text-sm">
        {task.running ? (
          <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Running
          </span>
        ) : (
          <span className="text-muted-foreground">Idle</span>
        )}
      </td>
      <td className="py-2.5 text-right">
        <button
          type="button"
          onClick={() => {
            setRunningName(task.name);
            runMutation.mutate(task.name);
          }}
          disabled={isRunning}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs border border-border rounded-lg hover:bg-muted disabled:opacity-50 transition-all focus-ring"
        >
          {runMutation.isPending ? <LoadingSpinner className="w-3 h-3" /> : <ZapIcon className="w-3 h-3" />}
          Run Now
        </button>
      </td>
    </tr>
  );
}

export function ScheduledTasks() {
  const { data: tasks, isLoading } = useQuery({
    queryKey: queryKeys.systemTasks(),
    queryFn: api.getSystemTasks,
    refetchInterval: 30_000,
  });

  return (
    <SettingsSection
      icon={<ClockIcon className="w-5 h-5 text-primary" />}
      title="Scheduled Tasks"
      description="Background jobs and their execution status."
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <LoadingSpinner className="w-4 h-4" />
          Loading tasks...
        </div>
      )}

      {tasks && tasks.length === 0 && (
        <p className="text-sm text-muted-foreground">No scheduled tasks.</p>
      )}

      {tasks && tasks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Task</th>
                <th className="pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Run</th>
                <th className="pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Next Run</th>
                <th className="pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <TaskRow key={task.name} task={task} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}
