#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-origin}"
SOURCE_BRANCH="${SOURCE_BRANCH:-ccg}"
TARGET_BRANCH="${TARGET_BRANCH:-master}"
RUN_VERIFY=1

usage() {
  cat <<'EOF'
Usage: bun run sync-ccg-to-master [--skip-verify]

Sync the ccg branch into master and push master to GitHub.

Environment overrides:
  REMOTE=origin
  SOURCE_BRANCH=ccg
  TARGET_BRANCH=master
EOF
}

for arg in "$@"; do
  case "$arg" in
    --skip-verify)
      RUN_VERIFY=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_clean_worktree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree has uncommitted changes. Commit or stash them before syncing." >&2
    git status --short
    exit 1
  fi
}

require_no_git_operation_in_progress() {
  local git_dir
  git_dir="$(git rev-parse --git-dir)"

  if [[ -e "$git_dir/MERGE_HEAD" || -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
    echo "A merge or rebase is already in progress. Finish or abort it before syncing." >&2
    exit 1
  fi
}

require_branch() {
  local branch="$1"
  if ! git show-ref --verify --quiet "refs/heads/$branch"; then
    echo "Required local branch does not exist: $branch" >&2
    exit 1
  fi
}

require_remote_branch() {
  local branch="$1"
  if ! git show-ref --verify --quiet "refs/remotes/$REMOTE/$branch"; then
    echo "Required remote branch does not exist: $REMOTE/$branch" >&2
    exit 1
  fi
}

ensure_target_can_fast_forward() {
  local local_ref="$TARGET_BRANCH"
  local remote_ref="$REMOTE/$TARGET_BRANCH"

  if git merge-base --is-ancestor "$local_ref" "$remote_ref"; then
    return
  fi

  if git merge-base --is-ancestor "$remote_ref" "$local_ref"; then
    return
  fi

  echo "$TARGET_BRANCH and $remote_ref have diverged. Resolve that manually before syncing." >&2
  exit 1
}

require_clean_worktree
require_no_git_operation_in_progress

echo "Fetching $REMOTE ..."
git fetch "$REMOTE"

require_branch "$SOURCE_BRANCH"
require_branch "$TARGET_BRANCH"
require_remote_branch "$TARGET_BRANCH"
ensure_target_can_fast_forward

echo "Checking out $TARGET_BRANCH ..."
git checkout "$TARGET_BRANCH"

echo "Fast-forwarding $TARGET_BRANCH from $REMOTE/$TARGET_BRANCH ..."
git merge --ff-only "$REMOTE/$TARGET_BRANCH"

echo "Merging $SOURCE_BRANCH into $TARGET_BRANCH ..."
git merge --no-ff "$SOURCE_BRANCH"

if [[ "$RUN_VERIFY" -eq 1 ]]; then
  echo "Running verification ..."
  bun run verify
else
  echo "Skipping verification."
fi

echo "Pushing $TARGET_BRANCH to $REMOTE ..."
git push "$REMOTE" "$TARGET_BRANCH"

echo "Done: $SOURCE_BRANCH has been synced into $TARGET_BRANCH and pushed to $REMOTE."
