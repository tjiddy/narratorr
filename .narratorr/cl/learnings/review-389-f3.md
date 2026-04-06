---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsPage.test.tsx]
issue: 389
source: review
date: 2026-04-06
---
When composing multiple settings cards on a single page, all sharing the same queryKeys.settings() cache key, dirty-state preservation across cards must be explicitly tested at the page level. The !isDirty guard in each card's useEffect prevents resets, but this interaction only manifests when one card saves (triggering invalidateQueries) while another is dirty. The old GeneralSettings dirty-state test no longer covered this after the sections moved to a new page.
