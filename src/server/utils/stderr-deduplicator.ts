import type { FastifyBaseLogger } from 'fastify';

/** Deduplicates repeated stderr lines before logging. */
export function createStderrDeduplicator(log: FastifyBaseLogger) {
  let lastLine = '';
  let count = 0;

  function flushPrevious() {
    if (count === 0) return;
    if (count === 1) {
      log.debug({ stderr: lastLine }, 'ffmpeg stderr');
    } else {
      log.debug({ stderr: lastLine, count }, `ffmpeg stderr (× ${count})`);
    }
    count = 0;
    lastLine = '';
  }

  return {
    push(line: string) {
      if (line === lastLine) {
        count++;
      } else {
        flushPrevious();
        lastLine = line;
        count = 1;
      }
    },
    flush() {
      flushPrevious();
    },
  };
}
