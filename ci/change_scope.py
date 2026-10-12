#!/usr/bin/env python3
"""Skip runtime jobs only when the complete diff modifies the root README."""
import json
import os
from pathlib import Path
import subprocess


def readme_only(base: str, head: str, *, three_dot: bool = False) -> bool:
    separator = "..." if three_dot else ".."
    try:
        # NUL separators and an unbounded git diff avoid GitHub's path-filter
        # file limit, renamed-path ambiguity, and filenames containing newlines.
        changes = subprocess.check_output([
            "git", "diff", "--no-renames", "--name-status", "-z", base + separator + head,
        ])
        return changes == b"M\0README.md\0"
    except subprocess.CalledProcessError:
        # Missing history must never turn an unverified code change into docs.
        return False


def runtime_required(event_name: str, event: dict) -> bool:
    if event_name == "pull_request":
        pr = event["pull_request"]
        return not readme_only(pr["base"]["sha"], pr["head"]["sha"], three_dot=True)
    if event_name == "push":
        return not readme_only(event["before"], event["after"])
    inputs = event.get("inputs", {})
    if event_name == "workflow_dispatch" and inputs.get("readme_only") in (True, "true"):
        if not inputs.get("tmsense_ref"):
            return not readme_only("origin/main", "HEAD", three_dot=True)
    return True


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    required = runtime_required(os.environ["GITHUB_EVENT_NAME"], event)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"runtime={str(required).lower()}\n")
    print("Full runtime checks required" if required else "README only: runtime jobs skipped")
