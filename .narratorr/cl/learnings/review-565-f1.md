---
scope: [core]
files: [src/core/download-clients/sabnzbd.ts]
issue: 565
source: review
date: 2026-04-15
---
When extracting a new transport method alongside an existing `request()` helper, the new method must replicate ALL response guards from the original — especially content-type checks for proxy/HTML interception. The gap was caused by focusing on the happy-path shape (`response.json()`) without checking what the existing method does between `response.ok` and JSON parsing.
