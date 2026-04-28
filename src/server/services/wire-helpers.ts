/**
 * Helpers for the wire-once contract used by services with cyclic / late-bound
 * required dependencies. The composition root constructs each service with its
 * acyclic constructor args, then calls `wire(deps)` exactly once with the
 * cyclic deps. Methods that need wired deps call `requireWired()` to get them
 * — pre-wire usage throws ServiceWireError instead of silently no-op'ing.
 */

export class ServiceWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceWireError';
  }
}

/**
 * Mixin used by required-wiring services. Tracks a single wireDeps slot
 * with set-once and require-set semantics.
 */
export class WireOnce<T> {
  private deps?: T;

  constructor(private serviceName: string) {}

  set(deps: T): void {
    if (this.deps !== undefined) {
      throw new ServiceWireError(`${this.serviceName}.wire() called more than once`);
    }
    this.deps = deps;
  }

  require(): T {
    if (this.deps === undefined) {
      throw new ServiceWireError(
        `${this.serviceName} used before wire() — required cyclic deps not configured. Call ${this.serviceName}.wire(deps) during composition before invoking methods that need them.`,
      );
    }
    return this.deps;
  }

  isWired(): boolean {
    return this.deps !== undefined;
  }
}
