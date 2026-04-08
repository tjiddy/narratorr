---
scope: [backend]
files: [src/server/services/blacklist.service.ts]
issue: 411
date: 2026-04-08
---
When a service already has a comprehensive method (getBlacklistedIdentifiers with dual-field + expiry), simpler convenience methods (isBlacklisted) should delegate to it rather than implement parallel logic. The delegation pattern used by getBlacklistedHashes() was the template — wrap single values in arrays, destructure the result. This avoids the exact drift bug #411 fixed (isBlacklisted only checking infoHash while getBlacklistedIdentifiers checked both).
