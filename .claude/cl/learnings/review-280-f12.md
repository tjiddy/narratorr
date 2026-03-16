---
scope: [scope/frontend]
files: [src/client/pages/settings/SystemSettings.tsx, src/client/App.tsx, src/client/components/layout/Layout.tsx]
issue: 280
source: review
date: 2026-03-10
---
The System settings route registration in App.tsx and nav link in Layout.tsx were untested. Prevention: new page additions should include smoke tests verifying the route renders and the nav link appears.
