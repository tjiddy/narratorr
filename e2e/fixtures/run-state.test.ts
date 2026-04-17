import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerFake,
  getRegisteredFakes,
  clearRegisteredFakes,
  _resetRegisteredFakesForTests,
  type FakeHandle,
} from './run-state.js';

describe('fake-server registry', () => {
  beforeEach(() => {
    _resetRegisteredFakesForTests();
  });

  function stub(name: string): FakeHandle {
    return { name, close: async () => {} };
  }

  it('starts with an empty registry', () => {
    expect(getRegisteredFakes()).toEqual([]);
  });

  it('records fakes in registration order', () => {
    const mam = stub('mam');
    const qbit = stub('qbit');
    registerFake(mam);
    registerFake(qbit);

    expect(getRegisteredFakes()).toEqual([mam, qbit]);
  });

  it('clearRegisteredFakes empties the registry', () => {
    registerFake(stub('mam'));
    registerFake(stub('qbit'));
    clearRegisteredFakes();

    expect(getRegisteredFakes()).toEqual([]);
  });

  it('registering after clear starts from an empty registry again', () => {
    registerFake(stub('mam'));
    clearRegisteredFakes();

    const qbit = stub('qbit');
    registerFake(qbit);
    expect(getRegisteredFakes()).toEqual([qbit]);
  });
});
