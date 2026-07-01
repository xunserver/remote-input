---
name: git-auto-push
description: Automatically commit local repository changes and push the current branch to the same Git remote. Use when the user asks to commit and push, auto-commit, push code, publish current changes, or save local work to the existing remote branch.
---

# Git Auto Push

Use this workflow to commit current repository changes and push them to the same remote branch.

## Workflow

1. Inspect state:
   - Run `git status --short --branch`.
   - Run `git remote -v`.
   - Run `git diff --stat`.

2. Verify scope:
   - Review diffs for files that will be committed.
   - Do not include unrelated generated output, secrets, build artifacts, or ignored reference folders.
   - If unrelated user changes are present and risky to bundle, stop and ask before committing.

3. Validate when practical:
   - Run the project’s relevant build or test command if it is known and reasonably scoped.
   - If validation is skipped, state why in the final response.

4. Commit:
   - Stage only intended files with explicit paths when possible.
   - Use a concise conventional-style commit message inferred from the change, such as `fix: ...`, `feat: ...`, or `docs: ...`.
   - Run `git commit -m "<message>"`.

5. Push:
   - Determine the current branch from `git status --short --branch`.
   - If the branch has an upstream, push with `git push`.
   - If there is no upstream, push to the same remote used by the repository's main remote, normally `origin`, with:
     `git push -u origin HEAD`.
   - Do not force-push unless the user explicitly asks.

6. Confirm:
   - Run `git status --short --branch`.
   - Report the commit hash, commit message, remote, branch, validation command, and whether the worktree is clean.

## Safety

- Never run destructive git commands such as `git reset --hard` or `git checkout --` unless explicitly requested.
- Do not amend, rebase, force-push, or rewrite history unless explicitly requested.
- If push is rejected because the remote has new commits, fetch and inspect before deciding whether to merge, rebase, or ask the user.
