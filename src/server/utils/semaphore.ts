// Each acquisition mints an idempotent releaser so duplicate teardown signals cannot over-release.
export type SemaphoreRelease = () => void;

export class Semaphore {
  private queue: Array<(release: SemaphoreRelease) => void> = [];
  private active = 0;

  constructor(private max: number) {}

  setMax(newMax: number): void {
    this.max = newMax;
  }

  async acquire(): Promise<SemaphoreRelease> {
    if (this.active < this.max) {
      this.active++;
      return this.makeRelease();
    }
    return new Promise<SemaphoreRelease>(resolve => {
      this.queue.push(resolve);
    });
  }

  tryAcquire(): SemaphoreRelease | null {
    if (this.active < this.max) {
      this.active++;
      return this.makeRelease();
    }
    return null;
  }

  private makeRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  // A prior setMax shrink may leave active above max; do not wake until capacity returns.
  private releaseSlot(): void {
    this.active--;
    if (this.active < this.max) {
      const next = this.queue.shift();
      if (next) {
        this.active++;
        next(this.makeRelease());
      }
    }
  }
}
