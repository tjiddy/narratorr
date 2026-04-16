import { config } from '../config.js';

/** Monitor poll interval — default every 30 seconds; override via `MONITOR_INTERVAL_CRON` env var. */
export const MONITOR_CRON_INTERVAL = config.monitorIntervalCron;
