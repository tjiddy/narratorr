// The health-report wire contract. Shared rather than mirrored: the server serializes these
// shapes and the dashboard routes on them, so a target arm added on one side only would
// serialize successfully and then be dropped or misrouted by the other, with nothing at
// compile time to catch it (#2312).

export type HealthState = 'healthy' | 'warning' | 'error';

/**
 * Where a failing check sends the operator. Connector-shaped arms carry the row id because
 * display names are neither unique nor immutable; singleton checks carry a path instead.
 */
export type HealthCheckTarget =
  | { kind: 'indexer'; id: number }
  | { kind: 'download-client'; id: number }
  | { kind: 'notifier'; id: number }
  | { kind: 'settings'; path: string }
  | { kind: 'route'; path: string };

// The optionals are `| undefined` rather than bare-optional so the server can assign an
// explicit undefined under exactOptionalPropertyTypes; readers are unaffected.
export interface HealthCheckResult {
  checkName: string;
  state: HealthState;
  message?: string | undefined;
  target?: HealthCheckTarget | undefined;
  link?: { url: string; label: string } | undefined;
}
