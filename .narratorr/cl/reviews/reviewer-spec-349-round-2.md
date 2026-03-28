---
skill: review-spec
issue: 349
round: 2
date: 2026-03-15
new_findings_on_original_spec: [F5]
---

### F5: Extracted phase context omits download data needed for torrent removal
**What I missed in round 1:** The spec's shared phase-context contract listed `book`, `author`, `targetPath`, `fileCount`, `targetSize`, `downloadId`, and `settings`, but not the `download` row or the subset of download fields required by `handleTorrentRemoval(download, minSeedTime)`. Combined with the "no re-fetch per phase" AC, that leaves the extracted torrent-removal phase without the data it needs.
**Why I missed it:** I verified the phase list and error semantics, but I did not cross-check the stated context payload against the exact signature of every extracted phase. I focused on whether the named collaborators and settings keys existed, not whether the shared context shape was sufficient for all named steps.
**Prompt fix:** Add: "When the spec says extracted phases receive a shared context/payload object, verify that the payload includes every field required by each named phase's existing method signature. If any named phase would need a re-fetch or hidden closure state because the payload omits required data, raise a blocking finding."
