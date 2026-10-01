"""Exercise the actual workflow shell against a stateful, offline GitHub API."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
HEAD = "a" * 40
OLD_HEAD = "b" * 40


def workflow_shell():
    lines = (ROOT / ".github/workflows/quorum-audit.yml").read_text().splitlines()
    start = lines.index("        run: |") + 1
    body = []
    for line in lines[start:]:
        if line and not line.startswith("          "):
            break
        body.append(line[10:])
    return "\n".join(body)


def signatures(controller="Controller", head=HEAD):
    return [
        {"body": f"Agent WS1: authored at {head}"},
        {"body": f"Agent R3: no findings on {head}"},
        {"body": f"Agent {controller}: concur at {head}"},
    ]


# Each invocation loads and saves state, like successive REST requests.
FAKE_GH = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json
    import os
    from pathlib import Path
    import sys

    state_path = Path(os.environ["FAKE_GH_STATE"])
    state = json.loads(state_path.read_text())
    args = sys.argv[1:]
    path = next(arg for arg in args if arg.startswith("repos/"))
    method = args[args.index("-X") + 1] if "-X" in args else "GET"
    payload = json.load(sys.stdin) if "--input" in args else None
    state.setdefault("calls", []).append({"path": path, "method": method, "payload": payload})
    error = False

    if path.endswith("/pulls/22"):
        reads = state.get("head_reads", 0)
        state["head_reads"] = reads + 1
        result = {"head": {"sha": state.get("next_head", state["head"]) if reads else state["head"]}}
    elif "/commits/" in path:
        result = state.get("check_pages", [{"check_runs": state.get("checks", [])}])
    elif "/comments?" in path:
        error = state.get("fail_comments", False)
        result = state.get("comments", [[]])
    elif "/reviews?" in path:
        error = state.get("fail_reviews", False)
        result = state.get("reviews", [[]])
    elif method == "POST":
        error = state.get("fail_create", False)
        result = {**payload, "id": 100, "app": {"slug": "github-actions"}}
        if not error:
            state.setdefault("checks", []).append(result)
    elif method == "PATCH":
        if "head_sha" in payload:
            raise RuntimeError("PATCH cannot change a check's commit")
        error = state.get("fail_publish", False) and payload.get("status") == "completed"
        check = next(item for item in state["checks"] if str(item["id"]) == path.rsplit("/", 1)[1])
        if not error:
            check.update(payload)
            if payload.get("status") == "in_progress":
                check.pop("conclusion", None)
        result = check
    else:
        raise RuntimeError("Unexpected API request: " + path)

    state_path.write_text(json.dumps(state))
    if error:
        print("simulated API failure", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
    """)


class QuorumAuditTest(unittest.TestCase):
    def run_audit(self, **changes):
        state = {"head": HEAD, "comments": [signatures()], "reviews": [[]]}
        state.update(changes)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            state_path = directory / "state.json"
            state_path.write_text(json.dumps(state))
            gh = directory / "gh"
            gh.write_text(FAKE_GH)
            gh.chmod(0o755)
            # Deliberately omit real credentials. The fake cannot use network.
            env = {"PATH": f"{directory}:{os.environ['PATH']}",
                   "GITHUB_REPOSITORY": "test/repo", "PR_NUMBER": "22",
                   "FAKE_GH_STATE": str(state_path)}
            result = subprocess.run(["bash", "-c", workflow_shell()], env=env,
                                    text=True, capture_output=True, timeout=20)
            return result, json.loads(state_path.read_text())

    def assert_conclusion(self, result, state, conclusion):
        self.assertEqual(result.returncode, 0 if conclusion == "success" else 1,
                         result.stdout + result.stderr)
        self.assertEqual(state["checks"][-1]["conclusion"], conclusion)

    def test_controller_and_legacy_labels(self):
        for label in ("Controller", "BOSS"):
            with self.subTest(label=label):
                result, state = self.run_audit(comments=[signatures(label)])
                self.assert_conclusion(result, state, "success")
                self.assertEqual(state["checks"][0]["head_sha"], HEAD)

    def test_existing_deployment_author_attestation(self):
        comments = signatures("BOSS")
        comments[0]["body"] = f"Agent WS1: implemented and live-proved ADR-0007 extract-api deployment at {HEAD}."
        result, state = self.run_audit(comments=[comments])
        self.assert_conclusion(result, state, "success")

    def test_missing_each_required_role(self):
        for missing in range(3):
            with self.subTest(missing=missing):
                comments = signatures()
                del comments[missing]
                result, state = self.run_audit(comments=[comments])
                self.assert_conclusion(result, state, "failure")

    def test_stale_sha_signatures(self):
        result, state = self.run_audit(comments=[signatures(head=OLD_HEAD)])
        self.assert_conclusion(result, state, "failure")

    def test_negative_worker_message_is_not_authorship(self):
        comments = signatures()
        comments[0]["body"] = f"Agent WS1: rejected work on {HEAD}"
        result, state = self.run_audit(comments=[comments])
        self.assert_conclusion(result, state, "failure")

    def test_multiple_pages_and_review_sources(self):
        comments = signatures()
        result, state = self.run_audit(
            comments=[[{"body": "Earlier discussion"}], comments[:1]],
            reviews=[[], [{**item, "state": "COMMENTED", "commit_id": HEAD} for item in comments[1:]]])
        self.assert_conclusion(result, state, "success")
        self.assertIn("reviews_scanned=2", state["checks"][0]["output"]["summary"])

    def test_dismissed_pending_and_changes_requested_reviews(self):
        for status in ("DISMISSED", "PENDING", "CHANGES_REQUESTED"):
            with self.subTest(status=status):
                comments = signatures()
                result, state = self.run_audit(comments=[comments[:1] + comments[2:]],
                    reviews=[[{**comments[1], "state": status, "commit_id": HEAD}]])
                self.assert_conclusion(result, state, "failure")

    def test_review_from_old_commit_is_not_current_proof(self):
        comments = signatures()
        result, state = self.run_audit(comments=[comments[:1] + comments[2:]],
            reviews=[[{**comments[1], "state": "APPROVED", "commit_id": OLD_HEAD}]])
        self.assert_conclusion(result, state, "failure")

    def existing_check(self):
        return {"id": 80, "name": "quorum-audit", "head_sha": HEAD,
                "external_id": f"quorum-audit:pr-22:{HEAD}",
                "app": {"slug": "github-actions"},
                "status": "completed", "conclusion": "success"}

    def test_deleted_comment_replaces_previous_success(self):
        result, state = self.run_audit(checks=[self.existing_check()], comments=[signatures()[:2]])
        self.assert_conclusion(result, state, "failure")
        self.assertEqual(len(state["checks"]), 1)
        updates = [call["payload"]["status"] for call in state["calls"] if call["method"] == "PATCH"]
        self.assertEqual(updates, ["in_progress", "completed"])

    def test_edited_and_dismissed_signatures_replace_previous_success(self):
        comments = signatures()
        scenarios = [
            {"comments": [[comments[0], {"body": "Review withdrawn"}, comments[2]]]},
            {"comments": [[comments[0], comments[2]]],
             "reviews": [[{**comments[1], "state": "DISMISSED", "commit_id": HEAD}]]},
        ]
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                result, state = self.run_audit(checks=[self.existing_check()], **scenario)
                self.assert_conclusion(result, state, "failure")

    def test_managed_check_on_later_page_is_reused(self):
        check = self.existing_check()
        result, state = self.run_audit(checks=[check],
            check_pages=[{"check_runs": []}, {"check_runs": [check]}])
        self.assert_conclusion(result, state, "success")
        self.assertEqual(len(state["checks"]), 1)

    def test_different_app_check_is_not_overwritten(self):
        check = {**self.existing_check(), "app": {"slug": "another-app"}}
        result, state = self.run_audit(checks=[check])
        self.assert_conclusion(result, state, "success")
        self.assertEqual(state["checks"][0], check)
        self.assertEqual(state["checks"][-1]["id"], 100)

    def test_read_failures_invalidate_previous_success(self):
        for failure in ("fail_comments", "fail_reviews"):
            with self.subTest(failure=failure):
                result, state = self.run_audit(checks=[self.existing_check()], **{failure: True})
                self.assert_conclusion(result, state, "failure")
                self.assertEqual(state["checks"][0]["output"]["title"], "Quorum audit could not complete")

    def test_publish_failure_is_visible_and_keeps_check_pending(self):
        result, state = self.run_audit(fail_publish=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["checks"][0]["status"], "in_progress")
        self.assertNotIn("conclusion", state["checks"][0])

    def test_create_failure_never_reports_success(self):
        result, state = self.run_audit(fail_create=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(state.get("checks"))

    def test_head_changed_during_audit(self):
        result, state = self.run_audit(next_head=OLD_HEAD)
        self.assert_conclusion(result, state, "failure")
        self.assertEqual(state["checks"][0]["output"]["title"], "PR head changed during quorum audit")


if __name__ == "__main__":
    unittest.main()
