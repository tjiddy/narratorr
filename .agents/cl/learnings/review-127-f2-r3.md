---
scope: [core]
files: [packages/core/src/utils/audio-processor.ts]
issue: 127
source: review
date: 2026-02-23
---
Node's `execFile` error objects carry a `stderr` property with the child process's stderr output, but `error.message` only contains the exit code info. When wrapping external CLI tools like ffmpeg, always extract and include `stderr` in error results — that's where the actual diagnostic output lives. The AC explicitly required "logs error with ffmpeg stderr" which was missed because `error.message` seemed sufficient.
