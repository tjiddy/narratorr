---
scope: [scope/frontend]
files: [src/client/components/library/BulkOperationsSection.tsx, src/client/components/library/BulkOperationsSection.test.tsx]
issue: 141
source: review
date: 2026-03-26
---
The reviewer caught that the BulkButton tooltip precedence was wrong: `disabledReason` was checked before the busy-state message, so when Convert was both ffmpeg-disabled AND another job was running, it showed the ffmpeg tooltip instead of "A bulk operation is already running."

Root cause: The ternary was written with `isDisabled && disabledReason` first, which meant any button with a disabledReason would always show that reason regardless of whether a job was running. The spec for AC5 says all non-running bulk buttons should show the busy-state tooltip when a job is running — but the Convert button's static disabledReason blocked this.

What would have prevented it: The AC5 test cases only covered Rename/Retag (buttons without a disabledReason). The Convert button's interaction with AC5 — the combination of `isAnyRunning` AND `isDisabled && disabledReason` — was not tested. The interaction matrix (AC5 × AC6) should have been covered: "what tooltip does Convert show when another job is running AND ffmpeg is not configured?"
