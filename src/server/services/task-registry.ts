export interface TaskMetadata {
  name: string;
  type: 'cron' | 'timeout';
  lastRun: string | null;
  nextRun: string | null;
  running: boolean;
}

interface RegisteredTask {
  name: string;
  type: 'cron' | 'timeout';
  fn: () => Promise<unknown>;
  cronExpression?: string;
  lastRun: Date | null;
  nextRun: Date | null;
  running: boolean;
}

export class TaskRegistry {
  private tasks: Map<string, RegisteredTask> = new Map();

  register(name: string, type: 'cron' | 'timeout', fn: () => Promise<unknown>, cronExpression?: string): void {
    this.tasks.set(name, { name, type, fn, cronExpression, lastRun: null, nextRun: null, running: false });
  }

  getAll(): TaskMetadata[] {
    return Array.from(this.tasks.values()).map((task) => ({
      name: task.name,
      type: task.type,
      lastRun: task.lastRun?.toISOString() ?? null,
      nextRun: task.nextRun?.toISOString() ?? (task.cronExpression ? this.estimateNextRun(task.cronExpression) : null),
      running: task.running,
    }));
  }

  async runTask(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`Task "${name}" not found`);
    if (task.running) throw new Error(`Task "${name}" is already running`);

    task.running = true;
    try {
      await task.fn();
      task.lastRun = new Date();
    } finally {
      task.running = false;
    }
  }

  /**
   * Run a custom function under a registered task's concurrency guard.
   * Uses the task's running flag for mutual exclusion but executes the provided
   * function instead of the registered one — useful when callers need the return value.
   */
  async runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`Task "${name}" not found`);
    if (task.running) throw new Error(`Task "${name}" is already running`);

    task.running = true;
    try {
      const result = await fn();
      task.lastRun = new Date();
      return result;
    } finally {
      task.running = false;
    }
  }

  /**
   * Execute a task with tracking (for live schedulers).
   * Unlike runTask(), silently skips if already running (no queueing, no error).
   */
  async executeTracked(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task || task.running) return;
    task.running = true;
    try {
      await task.fn();
      task.lastRun = new Date();
    } finally {
      task.running = false;
    }
  }

  /** Set the next scheduled run time (for timeout-loop jobs). */
  setNextRun(name: string, date: Date): void {
    const task = this.tasks.get(name);
    if (task) task.nextRun = date;
  }

  private estimateNextRun(cronExpression: string): string {
    // Simple estimation for cron-based jobs
    // node-cron doesn't expose a next-run API, so we return a rough estimate
    try {
      const parts = cronExpression.split(' ');
      const now = new Date();
      // For second-based patterns (6 parts) — check BEFORE 5-part to avoid misclassification
      if (parts.length === 6) {
        const secondPart = parts[0];
        if (secondPart.startsWith('*/')) {
          const interval = parseInt(secondPart.slice(2), 10);
          const nextSecond = Math.ceil((now.getSeconds() + 1) / interval) * interval;
          const next = new Date(now);
          next.setSeconds(nextSecond % 60);
          next.setMilliseconds(0);
          if (nextSecond >= 60) next.setMinutes(next.getMinutes() + 1);
          return next.toISOString();
        }
      }
      // For standard 5-part minute-based patterns
      if (parts.length === 5) {
        const minutePart = parts[0];
        if (minutePart.startsWith('*/')) {
          const interval = parseInt(minutePart.slice(2), 10);
          const nextMinute = Math.ceil((now.getMinutes() + 1) / interval) * interval;
          const next = new Date(now);
          next.setMinutes(nextMinute % 60);
          next.setSeconds(0);
          next.setMilliseconds(0);
          if (nextMinute >= 60) next.setHours(next.getHours() + 1);
          return next.toISOString();
        }
      }
      return now.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
}
