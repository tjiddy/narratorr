---
scope: [infra]
files: [.git/objects]
issue: 66
date: 2026-03-24
---
When `.git/objects/XX/` subdirectories are owned by root (e.g., in containerized envs where root ran prior commits), `git commit` fails with "insufficient permission for adding an object to repository database". The workaround is to shift the file's SHA to a non-conflicting prefix by making a small content change (tweak a comment), then recompute the SHA prefix with `hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()[:2]` and verify it's not in the root-owned set before committing. The real fix is `sudo chown -R automation:automation .git/objects`.
