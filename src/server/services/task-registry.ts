export class TaskRegistryError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'ALREADY_RUNNING',
  ) {
    super(message);
    this.name = 'TaskRegistryError';
  }
}

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
    this.tasks.set(name, { name, type, fn, ...(cronExpression !== undefined && { cronExpression }), lastRun: null, nextRun: null, running: false });
  }

  getAll(): TaskMetadata[] {
    return Array.from(this.tasks.values()).map((task) => ({
      name: task.name,
      type: task.type,
      lastRun: task.lastRun?.toISOString() ?? null,
      nextRun: task.nextRun?.toISOString() ?? null,
      running: task.running,
    }));
  }

  async runTask(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task) throw new TaskRegistryError(`Task "${name}" not found`, 'NOT_FOUND');
    if (task.running) throw new TaskRegistryError(`Task "${name}" is already running`, 'ALREADY_RUNNING');

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
    if (!task) throw new TaskRegistryError(`Task "${name}" not found`, 'NOT_FOUND');
    if (task.running) throw new TaskRegistryError(`Task "${name}" is already running`, 'ALREADY_RUNNING');

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

  /**
   * Set the next scheduled run time. Cron jobs feed this from croner's own
   * `Cron.nextRun()`; timeout-loop jobs feed it from their computed interval.
   */
  setNextRun(name: string, date: Date): void {
    const task = this.tasks.get(name);
    if (task) task.nextRun = date;
  }
}
