# /review <pr-number> — Review a pull request against its linked issue

Reviews a PR by checking the diff against the linked issue's acceptance criteria. Posts a structured review comment on the PR.

## Steps

1. **Fetch PR details:** Run `pnpm gitea pr <pr-number>`. Extract:
   - Title, body, state, head branch, base branch, labels
   - Linked issue: parse `Refs #<id>` from PR body

2. **Read linked issue:** Run `pnpm gitea issue <id>`. Extract the **Acceptance Criteria** section.

3. **Fetch the diff:**
   ```bash
   git fetch origin <head-branch>
   git diff main...<head-branch>
   ```

4. **Check each AC criterion against the diff:**
   - For each acceptance criterion, determine: `pass` | `partial` | `missing`
   - Note specific files/lines that address each criterion

5. **Check common issues:**
   - Missing tests for new functionality
   - Missing error handling / logging in catch blocks
   - Scope creep (changes not related to the issue)
   - Missing logging on CRUD operations or external API calls
   - Security concerns (injection, unsanitized input)

6. **Post review comment on PR:**
   - Write comment to temp file, then: `pnpm gitea pr-comment <pr-number> --body-file <temp-file-path>`
   - Template:
     ```
     ## AC Review

     | Criterion | Status | Notes |
     |-----------|--------|-------|
     | <AC item> | pass/partial/missing | <details> |

     ## Code Review

     - Tests: pass | missing (<what's missing>)
     - Error handling: pass | missing (<where>)
     - Logging: pass | missing (<where>)
     - Scope: clean | creep (<what>)
     - Security: pass | concern (<what>)

     ## Verdict: approve | needs-work

     <Summary — what needs to change, if anything>
     ```
   - Clean up temp file

7. **Report to main agent:** Overall verdict + issues found.

## Important

- This skill does NOT merge or approve via API — it only posts a comment
- If no `Refs #<id>` found in PR body, ask the user which issue to review against
- The diff can be large — focus on changed files, not the entire codebase
- Be constructive — flag real issues, not style preferences
