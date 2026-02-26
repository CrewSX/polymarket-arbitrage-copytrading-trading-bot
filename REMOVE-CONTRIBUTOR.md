# Remove 0xTan1319 and all merge-PR commits from main

You want **main** to be your current project only: linear history, **no** “Merge pull request” commits, so 0xTan1319 does not appear as a contributor.

---

## Back to main project (no merge commits)

If **main** was moved to a history that includes “Merge pull request #1/2/3” (e.g. after `reset --hard main-backup`) and you want to **restore** the previous **main** (your 10-commit linear history, no merges):

```bash
cd /home/dev/workshop/poly-git
git checkout main

# Restore main to the tip you had before the merge history (no merge commits)
git reset --hard 1e250ffe910ee74be079d75ef0a68b5b8d85923f

# Update GitHub so main has no merge commits and 0xTan1319 drops off
git push --force origin main
```

If that commit is gone, find the old main tip in the reflog and use it instead:

```bash
git reflog
# Find the entry like "HEAD@{N}: reset: moving to main-backup" and use the commit *before* it,
# or the one that says "checkout: moving from main-backup to main" / "commit: feat: update final testing"
git reset --hard <OLD_MAIN_COMMIT_HASH>
git push --force origin main
```

Result: **main** on GitHub will be your linear history only (e.g. “feat: update final testing”, etc.), with **no** “Merge pull request” commits and no 0xTan1319 in the contributor list.

---

## (Optional) If you had only rewritten merge messages

If you only wanted to rewrite merge messages (not remove merges), you would run filter-branch on **main-backup** then `reset main --hard main-backup` and force-push. That leaves merge commits in history with messages like “Merge pull request #3” (no “from 0xTan1319/levente”). For a clean “main project only” history, use the “Back to main project” steps above instead.
