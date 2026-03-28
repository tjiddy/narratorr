---
skill: respond-to-pr-review
issue: 356
pr: 385
round: 2
date: 2026-03-15
fixed_findings: [F7]
---
### F7: Chunking test doesn't prove EVENT_CHUNK=998 contract
**What was caught:** The 1500-ID test only checked db.select call count, which would be identical for EVENT_CHUNK=998 and EVENT_CHUNK=999 (both produce 2 event chunks for 1500 IDs).
**Why I missed it:** I focused on proving the chunking mechanism works (multiple calls happen) without verifying the specific chunk boundary. The original test input of 1500 didn't sit at the boundary that differentiates 998 from 999.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 (fix completeness gate): "For chunking/boundary tests, verify the test input sits exactly at the value that differentiates the correct boundary from an off-by-one regression. If N and N±1 produce the same observable output, the test is vacuous."
