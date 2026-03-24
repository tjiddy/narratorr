# Technical Debt

## Orchestrator

- **Stale skills on first dispatch:** Automation worker clones only pull main during container startup (entrypoint). If a skill file changes on main mid-session, the first dispatch after the change runs the old version — the `git pull` inside the skill updates the clone but the skill is already loaded. Fix: add `git fetch origin main && git reset --hard origin/main` to orchestrator pre-dispatch. Low urgency — only matters when skills change, and the second dispatch picks it up.
