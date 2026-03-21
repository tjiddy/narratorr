---
scope: [frontend]
files: [src/client/components/PathInput.tsx]
issue: 50
source: review
date: 2026-03-21
---
RHF's register().onChange reads event.target.name (not event.target.value) first to look up the field in _fields[]. Passing a plain string throws 'Cannot read properties of undefined (reading name)'. Passing { target: { value } } (no name) silently returns no-op because _fields[undefined] is undefined. The correct synthetic event for programmatic RHF onChange calls must include name: registration.name alongside value — { target: { name: registration.name, value: path } }. This would have been caught by reading the RHF source or testing with a real useForm() instance rather than a vi.fn() mock for registration.onChange.
