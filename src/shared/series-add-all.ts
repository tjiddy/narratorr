/**
 * The single Add All selection rule. The Series card computes its `Add All (N)` label with it and
 * the batch service decides what to create with it, so the count the user sees and the set the
 * server builds cannot diverge.
 */

export interface AddAllSelectableMember {
  title: string;
  position: number | null;
  inLibrary: boolean;
}

/**
 * Major entries only. Fractional, null, zero and negative positions are novellas, companions and
 * prequels; they stay reachable through the per-row `+ Add`. The blank-title clause belongs here
 * rather than downstream because the batch calls `BookService.create` internally, bypassing
 * `createBookBodySchema`'s nonblank check.
 */
export function isAddAllSelectable(member: AddAllSelectableMember): boolean {
  if (member.inLibrary) return false;
  if (member.position === null || !Number.isInteger(member.position) || member.position < 1) return false;
  return member.title.trim() !== '';
}

export function selectAddAllMembers<T extends AddAllSelectableMember>(members: readonly T[]): T[] {
  return members.filter(isAddAllSelectable);
}

export type AddAllDisposition = 'created' | 'owned' | 'held' | 'failed';

export interface AddAllMemberResult {
  title: string;
  position: number;
  disposition: AddAllDisposition;
  /** The created row, or the incumbent for `owned`/`held`; null when nothing durable exists. */
  bookId: number | null;
}

export interface AddAllSeriesResponse {
  requested: number;
  created: number;
  owned: number;
  held: number;
  failed: number;
  members: AddAllMemberResult[];
}

export const ADD_ALL_IN_FLIGHT_MESSAGE = 'Add All is already running for this series';
