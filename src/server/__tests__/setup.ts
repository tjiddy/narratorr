import { beforeEach } from 'vitest';
import { resetBookAdmissionLocks } from '../utils/book-admission-lock.js';
import { resetRootGate } from '../services/library-root-gate.js';

/**
 * The admission map and the root-scope gate are module-level registries shared by every case in a
 * file. A case that starts a mutator and asserts without awaiting it leaves a live chain behind,
 * and the next case's mutator queues on it — a hang that reads as an unrelated assertion failure.
 * Neither registry carries state a test should inherit, so both reset per case.
 */
beforeEach(() => {
  resetBookAdmissionLocks();
  resetRootGate();
});
