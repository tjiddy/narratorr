/**
 * Module-level registry for fake-server handles that global-setup starts and
 * global-teardown must close. Same rationale as temp-dirs.ts: Playwright
 * invokes globalSetup and globalTeardown in the same Node process that loaded
 * the config, so module state is sufficient — no state file needed.
 *
 * Kept separate from temp-dirs.ts because the two registries have distinct
 * lifecycles: temp dirs are created at config-load time, fakes are started
 * later in globalSetup.
 */

export interface FakeHandle {
  /** Human-readable name, e.g. "mam" or "qbit". For logging only. */
  name: string;
  /** Stops the underlying Fastify listener. */
  close: () => Promise<void>;
}

let registeredFakes: FakeHandle[] = [];

/** Record a fake-server handle for globalTeardown to close. */
export function registerFake(handle: FakeHandle): void {
  registeredFakes.push(handle);
}

/** Returns the current list of registered fakes (teardown consumes this). */
export function getRegisteredFakes(): readonly FakeHandle[] {
  return registeredFakes;
}

/** Clears the registry. Called by globalTeardown after closing all handles. */
export function clearRegisteredFakes(): void {
  registeredFakes = [];
}

/** Resets module-level state — for tests only. */
export function _resetRegisteredFakesForTests(): void {
  registeredFakes = [];
}
