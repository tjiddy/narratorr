---
scope: [scope/infra]
files: []
issue: 284
source: spec-review
date: 2026-03-09
---
Spec left partial PUID/PGID behavior ambiguous ("default GID (or same as PUID)"). For shell entrypoint scripts, every partial-config combination must have a single defined behavior — implementers can't guess which alternative to pick and testers can't write assertions against "or".
