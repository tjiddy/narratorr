---
scope: [backend, core]
files: [src/server/services/import.service.ts, src/server/services/bulk-operation.service.ts, src/core/utils/audio-processor.ts]
issue: 210
source: review
date: 2026-03-29
---
Service-level wiring of new naming options was untested. The lower-level helpers (`buildTargetPath`, `renderFilename`) had tests for the options parameter, but no test verified that the services correctly extract `namingSeparator`/`namingCase` from library settings and forward them. A regression in any service's settings-to-options extraction would leave real import/rename/bulk operations using default formatting while helper tests pass. Fix: added service-level tests with non-default settings that assert the options flow through. Pattern: when threading new parameters through a call chain, test at BOTH the helper boundary AND the service orchestration level.
