#!/usr/bin/env python3
"""Verify that a checked release still matches main except for the root README."""
import json
import subprocess
import sys


def runtime_entries(tree: dict) -> list[tuple[str, str, str, str]]:
    if tree.get("truncated") is not False or not isinstance(tree.get("tree"), list):
        raise ValueError("GitHub did not return a complete root tree")
    # Directory SHAs cover every descendant, so this compares all source and
    # configuration without API pagination or a changed-file count limit.
    return sorted(
        (entry["path"], entry["mode"], entry["type"], entry["sha"])
        for entry in tree["tree"] if entry["path"] != "README.md"
    )


def api(path: str) -> dict:
    return json.loads(subprocess.check_output(["gh", "api", path]))


def verify(candidate_sha: str, repository: str) -> str:
    current = api(f"repos/{repository}/commits/main")
    if current["sha"] == candidate_sha:
        return current["sha"]
    candidate = api(f"repos/{repository}/commits/{candidate_sha}")
    candidate_tree = api(f"repos/{repository}/git/trees/{candidate['commit']['tree']['sha']}")
    current_tree = api(f"repos/{repository}/git/trees/{current['commit']['tree']['sha']}")
    if runtime_entries(candidate_tree) != runtime_entries(current_tree):
        raise ValueError("main contains changes beyond README.md; this release is stale")
    return current["sha"]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: runtime_identity.py <checked-commit-sha> <owner/repository>")
    print(verify(sys.argv[1], sys.argv[2]))
