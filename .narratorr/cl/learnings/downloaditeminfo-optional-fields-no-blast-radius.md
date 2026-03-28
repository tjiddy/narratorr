---
scope: [core]
files: [src/core/download-clients/types.ts]
issue: 117
date: 2026-03-25
---
Adding an optional field (`errorMessage?: string`) to `DownloadItemInfo` has zero blast radius — all existing adapter implementations continue to satisfy the interface without changes. No test fixtures needed updating. This contrasts with adding a required field, which would require updating every adapter and every test fixture that constructs a `DownloadItemInfo`. For interface extensions on core adapter types, prefer optional fields when the data isn't universally available across all adapter types.
