/**
 * Provider rounding and rip credits create a fixed error, not one proportional
 * to book length. UAT widened the band from 90s; 240s remains below the closest
 * verified different recording at 360s (#1854).
 */
export const DURATION_TOLERANCE_SECONDS = 240;

/** Provider runtimes and `books.duration` are minutes; callers must convert them to seconds. */
export function withinDurationTolerance(aSeconds: number, bSeconds: number): boolean {
  return Math.abs(aSeconds - bSeconds) <= DURATION_TOLERANCE_SECONDS;
}
