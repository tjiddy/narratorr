export class ServiceWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceWireError';
  }
}

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

  /** Read without requiring wiring; only for optional dependencies. */
  peek(): T | undefined {
    return this.deps;
  }

  isWired(): boolean {
    return this.deps !== undefined;
  }
}
