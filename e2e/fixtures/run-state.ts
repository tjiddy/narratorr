// Setup and teardown share a Node process; keep later-started fake handles separate from config-time temp dirs.

export interface FakeHandle {
  name: string;
  close: () => Promise<void>;
}

let registeredFakes: FakeHandle[] = [];

export function registerFake(handle: FakeHandle): void {
  registeredFakes.push(handle);
}

export function getRegisteredFakes(): readonly FakeHandle[] {
  return registeredFakes;
}

export function clearRegisteredFakes(): void {
  registeredFakes = [];
}

export function _resetRegisteredFakesForTests(): void {
  registeredFakes = [];
}
