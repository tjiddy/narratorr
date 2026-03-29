---
scope: [backend]
files: [src/server/utils/import-steps.ts]
issue: 210
source: review
date: 2026-03-29
---
When testing parameter forwarding through a multi-layer call chain (service → helper → processor), testing the top and bottom layers is not sufficient if there's a middle hop that could drop the parameter. `runAudioProcessing()` sits between `ImportService.importDownload()` (which passes naming options) and `processAudioFiles()` (which consumes them). Testing both endpoints passed, but the reviewer caught that the middle hop could silently drop `namingOptions` without failing either test. Pattern: for each layer in a forwarding chain, add at least one test that invokes that layer directly and asserts the parameter appears in the outgoing call.
