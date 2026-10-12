#!/usr/bin/env bash
set -euo pipefail

branch=automation/readme-structure
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
gh auth setup-git

# Reuse the automation branch without force-pushing or accumulating daily PRs.
# If a person added source changes there, stop before publishing anything.
remote=$(git ls-remote --heads origin "$branch")
if [[ -n "$remote" ]]; then
  git fetch origin "$branch:refs/remotes/origin/$branch"
  git switch --create "$branch" "origin/$branch"
  paths=$(git diff --name-only --no-renames origin/main...HEAD)
  [[ -z "$paths" || "$paths" == README.md ]] || { echo 'Automation branch contains non-README edits' >&2; exit 1; }
  git merge --no-edit origin/main
else
  git switch --create "$branch"
fi

python3 -m unittest discover -s ci -p 'test_*.py'
python3 ci/readme_structure.py
python3 ci/readme_structure.py --check

# Only the marked tree may differ from main, even if someone edited the bot
# branch by hand. Keep all prose and links under human ownership.
python3 - <<'PY'
from pathlib import Path
import subprocess
import sys
sys.path.insert(0, 'ci')
from readme_structure import replace_tree
base = subprocess.check_output(['git', 'show', 'origin/main:README.md']).decode()
current = Path('README.md').read_text()
if replace_tree(base, '') != replace_tree(current, ''):
    raise SystemExit('Refusing to publish README edits outside the generated tree')
PY

if git diff --quiet origin/main -- README.md; then
  echo 'Project structure is unchanged; no commit or pull request needed.' >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
if ! git diff --quiet -- README.md; then
  git add README.md
  git commit -m 'docs: refresh the tracked project structure'
fi
[[ "$(git diff --name-only --no-renames origin/main...HEAD)" == README.md ]] || exit 1
git push origin "HEAD:$branch"
commit=$(git rev-parse HEAD)

pr=$(gh pr list --head "$branch" --base main --state open --json number --jq '.[0].number // empty')
if [[ -z "$pr" ]]; then
  gh pr create --head "$branch" --base main \
    --title 'docs: refresh README project structure' \
    --body 'Refreshes only the generated directory tree from tracked repository paths. Written descriptions stay intact. The README-only required checks skip runtime builds, containers and production deployment.'
  pr=$(gh pr list --head "$branch" --base main --state open --json number --jq '.[0].number')
fi

# Bot-created PR events need workflow approval on GitHub. An explicit dispatch
# supplies the required GitHub Actions checks without an extra token or secret.
gh workflow run ci.yml --ref "$branch" -f readme_only=true
run_id=
for attempt in $(seq 30); do
  run_id=$(gh run list --workflow ci.yml --branch "$branch" --event workflow_dispatch \
    --commit "$commit" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [[ -z "$run_id" ]] || break
  sleep 2
done
[[ -n "$run_id" ]] || { echo 'README CI dispatch did not start' >&2; exit 1; }
gh run watch "$run_id" --exit-status
# Never bypass protection. If main advanced, leave the PR for the next daily
# run to update rather than merging a stale or unchecked commit.
gh pr merge "$pr" --squash --match-head-commit "$commit"
echo "Updated the project structure through PR #$pr; runtime deployment was not requested." >> "$GITHUB_STEP_SUMMARY"
