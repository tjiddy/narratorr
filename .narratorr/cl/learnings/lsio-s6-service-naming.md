---
scope: [backend, infra]
files: [docker/root/etc/s6-overlay/s6-rc.d/svc-narratorr/run]
issue: 292
date: 2026-03-10
---
LSIO s6-overlay services use `svc-` prefix convention (e.g., `svc-narratorr`), registered via empty file in `user/contents.d/`. The run script needs `#!/usr/bin/with-contenv bash` shebang to inherit container environment variables, and `s6-setuidgid abc` to run as the LSIO-remapped user.
