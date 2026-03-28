---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/OverflowMenu.test.tsx]
issue: 124
source: review
date: 2026-03-26
---
The reviewer caught that the Enter-on-Import test only asserted the menu closes, not that navigation to `/import` actually happened. A `click()` call on a React Router `Link` changes the memory router's location — any test that asserts only the side-effect (menu closes) rather than the root behavior (navigation) is vacuous: it would still pass if the keyboard handler regressed to `setOpen(false)` without calling click.

Why we missed it: The implementation reasoning was "Enter calls `.click()` on the item, and the Link's onClick calls `setOpen(false)`; therefore if the menu closes, the click fired." But that's circular — closing could happen any other way. The acceptance criterion explicitly required native Enter activation for the Import link, which means proving navigation, not just closure.

What would have prevented it: When writing tests for router-link activation, always assert the observable outcome of navigation (location changes to the target path) not just the incidental close behavior. Use `useLocation()` + a `LocationTracker` helper component in a custom render. Closing-menu assertions are always insufficient as proof of navigation.
