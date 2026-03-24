---
scope: [scope/frontend]
files: [src/client/pages/search/SearchPage.test.tsx]
issue: 69
source: review
date: 2026-03-24
---
An "ordering" acceptance criterion needs an order-sensitive test. A test that only asserts an element exists and is of a certain tag type does not prove ordering — it would pass even if interactive elements were inserted before the target.

Why we missed it: The test was written to satisfy "search form is the first interactive control" but only asserted existence. The ordering contract was described in prose but not encoded in the assertion.

What would have prevented it: When an AC says "X is the first Y" or "X appears before Y," the test must collect all Y in DOM order and assert X is at index 0. Use container.querySelectorAll('a[href], button, input, select, textarea') from the renderWithProviders container to get all interactive elements in document order, then assert allInteractive[0] is the target element.
