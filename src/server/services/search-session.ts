import { randomUUID } from 'crypto';

export interface SearchSessionIndexer {
  id: number;
  name: string;
}

export interface SearchSession {
  sessionId: string;
  indexers: SearchSessionIndexer[];
  controllers: Map<number, AbortController>;
}

export class SearchSessionManager {
  private sessions = new Map<string, SearchSession>();

  create(indexers: SearchSessionIndexer[]): SearchSession {
    const sessionId = randomUUID();
    const controllers = new Map<number, AbortController>();

    for (const indexer of indexers) {
      controllers.set(indexer.id, new AbortController());
    }

    const session: SearchSession = { sessionId, indexers, controllers };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): SearchSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Cancel a specific indexer within a session. Returns false if session or indexer not found. */
  cancel(sessionId: string, indexerId: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const controller = session.controllers.get(indexerId);
    if (!controller) return false;

    controller.abort();
    return true;
  }

  /** Remove session and abort all pending controllers. */
  cleanup(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const controller of session.controllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }

    this.sessions.delete(sessionId);
  }
}
