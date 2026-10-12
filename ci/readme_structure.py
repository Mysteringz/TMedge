#!/usr/bin/env python3
"""Maintain the README's directory tree from tracked paths, without dependencies."""
import argparse
from pathlib import Path, PurePosixPath
import subprocess

START = "<!-- project-structure:start -->"
END = "<!-- project-structure:end -->"
EXCLUDED = {"node_modules", "dist", "data", "__pycache__", "public-algo"}


def render(paths: list[str]) -> str:
    tree: dict = {}
    for name in paths:
        parts = PurePosixPath(name).parts
        if not parts or any(part in EXCLUDED for part in parts):
            continue
        if name.startswith(("public-web/app/", "public-console/js/")):
            continue
        if len(parts) == 1:
            if not name.startswith("."):
                tree.setdefault(name, None)
            continue
        cursor = tree
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})

    lines = ["```text", "TMedge/"]

    def walk(entries: dict, prefix: str = "") -> None:
        ordered = sorted(entries, key=lambda name: (entries[name] is None, name.casefold(), name))
        for index, name in enumerate(ordered):
            child = entries[name]
            label = name
            # Collapse directory-only chains to keep the existing overview compact.
            while isinstance(child, dict) and len(child) == 1:
                next_name = next(iter(child))
                label += "/" + next_name
                child = child[next_name]
            if child is not None:
                label += "/"
            label = label.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
            last = index == len(ordered) - 1
            lines.append(prefix + ("└── " if last else "├── ") + label)
            if isinstance(child, dict):
                walk(child, prefix + ("    " if last else "│   "))

    walk(tree)
    return "\n".join(lines + ["```"])


def replace_tree(readme: str, tree: str) -> str:
    if readme.count(START) != 1 or readme.count(END) != 1:
        raise ValueError("README must contain exactly one pair of project-structure markers")
    start = readme.index(START) + len(START)
    end = readme.index(END)
    if end < start:
        raise ValueError("project-structure markers are out of order")
    return readme[:start] + "\n" + tree + "\n" + readme[end:]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the generated tree is outdated")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    path = root / "README.md"
    current = path.read_text()
    updated = replace_tree(current, render([name for name in paths if name]))
    if current == updated:
        print("README project structure is current")
    elif args.check:
        raise SystemExit("README project structure needs updating")
    else:
        path.write_text(updated)
        print("Updated README project structure")


if __name__ == "__main__":
    main()
