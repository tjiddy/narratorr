// Stay below common ~60-second idle proxy cutoffs; the client watchdog derives
// its silence threshold from this value.
export const HEARTBEAT_INTERVAL_MS = 20_000;

// Named events are browser-observable for liveness; SSE comment frames are not.
// Search streams safely ignore this event because they register no hb listener.
export const SSE_HEARTBEAT_EVENT = 'hb';
