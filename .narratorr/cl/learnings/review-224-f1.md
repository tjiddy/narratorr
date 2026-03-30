---
scope: [frontend]
files: [src/client/components/settings/DownloadClientForm.test.tsx, src/client/components/settings/IndexerCard.test.tsx, src/client/components/settings/NotifierCardForm.test.tsx]
issue: 224
source: review
date: 2026-03-30
---
When migrating form elements to a shared component that adds new prop wiring (like `error={!!errors.type}`), the new prop must be tested at the consumer level — not just at the shared component level. For components that own their form (`useForm` internally), inject errors by rendering with invalid data that triggers zodResolver validation on submit. For components that receive the form as a prop, use `form.setError()` in a `useEffect` wrapper. The self-review and coverage review both flagged these as "pre-existing" or "defensive code" — but the reviewer correctly identified that untested wiring is a regression risk.
