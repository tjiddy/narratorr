# F18: Restore modal messaging and error toast untested

- **Issue**: #280
- **Date**: 2026-03-10
- **Scope**: scope/frontend
- **Resolution**: fixed
- **Files**: src/client/pages/settings/SystemSettings.tsx, src/client/pages/settings/SystemSettings.test.tsx

Tests stopped at "modal exists" without checking its content. Always assert user-visible text content (warning copy, data values) not just element presence — otherwise the modal could render empty and tests would still pass.
