"""Claims about README automation and the boundary around skipped runtime CI."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from change_scope import readme_only, runtime_required
from readme_structure import END, START, render, replace_tree
from runtime_identity import runtime_entries, verify


class StructureTest(unittest.TestCase):
    def test_tree_uses_sorted_tracked_directories_and_root_files(self):
        paths = ["src/web/main.ts", "README.md", "src/edge/main.ts", ".github/workflows/ci.yml"]
        expected = "```text\nTMedge/\n├── .github/workflows/\n├── src/\n│   ├── edge/\n│   └── web/\n└── README.md\n```"
        self.assertEqual(render(paths), expected)
        self.assertEqual(render(list(reversed(paths))), expected)

    def test_generated_and_private_directories_are_excluded(self):
        self.assertEqual(render(["node_modules/a/x", "data/recording.json", "dist/src/x.js", ".env", "public-web/app/x.js"]), "```text\nTMedge/\n```")

    def test_added_and_removed_directories_change_the_tree(self):
        self.assertNotEqual(render(["src/web/main.ts"]), render(["src/web/main.ts", "src/new/module.ts"]))

    def test_prose_is_preserved_and_update_is_idempotent(self):
        text = f"Introduction\n{START}\nold tree\n{END}\nWritten descriptions\n"
        updated = replace_tree(text, render(["README.md"]))
        self.assertTrue(updated.startswith("Introduction\n" + START))
        self.assertTrue(updated.endswith(END + "\nWritten descriptions\n"))
        self.assertEqual(replace_tree(updated, render(["README.md"])), updated)

    def test_missing_duplicate_or_reversed_markers_refuse_to_edit(self):
        for text in ["No markers", START + END + START, END + START]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                replace_tree(text, "tree")


class ScopeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        Path("README.md").write_text("initial")
        Path("code.ts").write_text("initial")
        self.base = self.commit()

    def tearDown(self):
        os.chdir(self.previous)
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL).decode().strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_only_a_modified_root_readme_skips_runtime(self):
        Path("README.md").write_text("changed")
        head = self.commit()
        self.assertTrue(readme_only(self.base, head))
        self.assertTrue(readme_only(self.base, head, three_dot=True))
        self.assertFalse(runtime_required("push", {"before": self.base, "after": head}))
        event = {"pull_request": {"base": {"sha": self.base}, "head": {"sha": head}}}
        self.assertFalse(runtime_required("pull_request", event))

    def test_mixed_code_change_runs_runtime_even_beyond_path_filter_limit(self):
        Path("README.md").write_text("changed")
        for index in range(310):
            Path(f"file-{index}.ts").write_text("code")
        self.assertFalse(readme_only(self.base, self.commit()))

    def test_deleted_renamed_empty_or_missing_history_runs_runtime(self):
        self.assertFalse(readme_only(self.base, self.base))
        with patch("subprocess.check_output", side_effect=subprocess.CalledProcessError(1, "git")):
            self.assertFalse(readme_only("missing", "HEAD"))
        Path("README.md").rename("README-renamed.md")
        self.assertFalse(readme_only(self.base, self.commit()))

    def test_assistant_knowledge_is_runtime_configuration(self):
        Path("config").mkdir()
        Path("config/ai-knowledge.md").write_text("assistant context")
        self.assertFalse(readme_only(self.base, self.commit()))

    def test_manual_firmware_checks_and_unknown_events_always_run_runtime(self):
        self.assertTrue(runtime_required("workflow_dispatch", {}))
        self.assertTrue(runtime_required("unknown", {}))
        event = {"inputs": {"readme_only": "true", "tmsense_ref": "firmware-branch"}}
        self.assertTrue(runtime_required("workflow_dispatch", event))

    def test_bot_dispatch_verifies_the_diff_instead_of_trusting_the_input(self):
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        event = {"inputs": {"readme_only": "true"}}
        self.assertTrue(runtime_required("workflow_dispatch", event))
        Path("README.md").write_text("changed")
        self.commit()
        self.assertFalse(runtime_required("workflow_dispatch", event))
        Path("code.ts").write_text("changed")
        self.commit()
        self.assertTrue(runtime_required("workflow_dispatch", event))


class RuntimeIdentityTest(unittest.TestCase):
    def tree(self, readme="readme-1", source="source-1", mode="040000"):
        return {"truncated": False, "tree": [
            {"path": "README.md", "mode": "100644", "type": "blob", "sha": readme},
            {"path": "src", "mode": mode, "type": "tree", "sha": source},
            {"path": "config", "mode": "040000", "type": "tree", "sha": "config-1"},
        ]}

    def test_only_the_root_readme_is_exempt_from_release_identity(self):
        self.assertEqual(runtime_entries(self.tree()), runtime_entries(self.tree(readme="readme-2")))
        self.assertNotEqual(runtime_entries(self.tree()), runtime_entries(self.tree(source="source-2")))
        self.assertNotEqual(runtime_entries(self.tree()), runtime_entries(self.tree(mode="160000")))
        updated = self.tree()
        updated["tree"][2]["sha"] = "config-2"
        self.assertNotEqual(runtime_entries(self.tree()), runtime_entries(updated))

    def test_incomplete_or_truncated_tree_fails_closed(self):
        for tree in [{}, {"tree": []}, {"tree": [], "truncated": True}]:
            with self.subTest(tree=tree), self.assertRaises(ValueError):
                runtime_entries(tree)

    def test_api_rechecks_main_and_accepts_only_readme_changes_after_approval(self):
        current = {"sha": "current", "commit": {"tree": {"sha": "current-tree"}}}
        candidate = {"sha": "checked", "commit": {"tree": {"sha": "checked-tree"}}}
        with patch("runtime_identity.api", side_effect=[current, candidate, self.tree(), self.tree(readme="new")]):
            self.assertEqual(verify("checked", "owner/repo"), "current")
        with patch("runtime_identity.api", side_effect=[current, candidate, self.tree(), self.tree(source="new")]):
            with self.assertRaises(ValueError):
                verify("checked", "owner/repo")


if __name__ == "__main__":
    unittest.main()
