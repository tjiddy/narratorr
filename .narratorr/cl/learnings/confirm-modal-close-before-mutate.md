---
scope: [frontend]
files: [src/client/components/ConfirmModal.tsx, src/client/pages/book/BookDetails.tsx]
issue: 111
date: 2026-03-25
---
`ConfirmModal` has no built-in pending/disabled state — the duplicate-submit guard is entirely caller-side. The correct pattern is `onConfirm={() => { setOpen(false); mutation.mutate(); }}`: close the modal first, then fire the mutation. This works because `isOpen=false` unmounts the dialog immediately, making subsequent confirm clicks impossible without re-opening. Do NOT rely on `isPending` to disable the confirm button — the ConfirmModal API has no such prop, so a second click before the mutation settles would fire a duplicate POST.
