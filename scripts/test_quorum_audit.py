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


def workflow_shell(step="Evaluate and publish current-head quorum"):
    lines = (ROOT / ".github/workflows/quorum-audit.yml").read_text().splitlines()
    marker = lines.index(f"      - name: {step}")
    start = lines.index("        run: |", marker) + 1
    body = []
    for line in lines[start:]:
        if line and not line.startswith("          "):
            break
        body.append(line[10:])
    return "\n".join(body)


def signatures(controller="Controller", head=HEAD):
    bodies = [
        {"body": f"Agent WS1: authored at {head}"},
        {"body": f"Agent R3: no findings on {head}"},
        {"body": f"Agent {controller}: concur at {head}"},
    ]
    return [{**item, "id": index + 1, "user": {"login": "maintainer", "type": "User"},
             "html_url": f"https://github.com/test/repo/pull/22#comment-{index + 1}"}
            for index, item in enumerate(bodies)]


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
        result = {"state": state.get("pr_state", "open"), "merged": state.get("merged", False),
                  "base": {"ref": "main", "repo": {"full_name": "test/repo"}},
                  "head": {"sha": state.get("next_head", state["head"]) if reads else state["head"]}}
    elif "/collaborators/" in path:
        error = state.get("fail_permissions", False)
        login = path.split("/collaborators/", 1)[1].split("/", 1)[0]
        result = {"permission": state.get("permissions", {}).get(login, "write")}
    elif path.endswith("/pulls?per_page=100"):
        result = state.get("associated_prs", [[{"number": 22, "state": "open", "base": {"ref": "main"}}]])
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
    def run_audit(self, audit_env=None, event=None, step="Evaluate and publish current-head quorum", **changes):
        state = {"head": HEAD, "comments": [signatures()], "reviews": [[]]}
        state.update(changes)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            state_path = directory / "state.json"
            state_path.write_text(json.dumps(state))
            gh = directory / "gh"
            gh.write_text(FAKE_GH)
            gh.chmod(0o755)
            event_path = directory / "event.json"
            event_path.write_text(json.dumps(event or {}))
            output_path = directory / "output"
            # Deliberately omit real credentials. The fake cannot use network.
            env = {"PATH": f"{directory}:{os.environ['PATH']}",
                   "GITHUB_REPOSITORY": "test/repo", "PR_NUMBER": "22",
                   "GITHUB_SERVER_URL": "https://github.com", "GITHUB_RUN_ID": "456",
                   "GITHUB_RUN_ATTEMPT": "2", "GITHUB_EVENT_NAME": "issue_comment",
                   "GITHUB_SHA": OLD_HEAD, "SOURCE_HEAD": "", "EXPECTED_HEAD": "",
                   "GITHUB_EVENT_PATH": str(event_path), "GITHUB_OUTPUT": str(output_path),
                   "FAKE_GH_STATE": str(state_path)}
            env.update(audit_env or {})
            result = subprocess.run(["bash", "-c", workflow_shell(step)], env=env,
                                    text=True, capture_output=True, timeout=20)
            final_state = json.loads(state_path.read_text())
            if output_path.exists():
                final_state["outputs"] = output_path.read_text()
            return result, final_state

    def assert_conclusion(self, result, state, conclusion):
        if conclusion == "success":
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
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

    def test_withdrawn_suffix_does_not_count(self):
        for role in range(3):
            with self.subTest(role=role):
                comments = signatures()
                comments[role]["body"] += " — WITHDRAWN; do not count this attestation"
                result, state = self.run_audit(comments=[comments])
                self.assert_conclusion(result, state, "failure")

    def test_ambiguous_legacy_worker_is_rejected(self):
        comments = signatures()
        comments[0]["body"] = f"Agent WS1: implemented nothing; rejected this work at {HEAD}"
        result, state = self.run_audit(comments=[comments])
        self.assert_conclusion(result, state, "failure")

    def test_signature_examples_do_not_count(self):
        for prefix in ("Example:\n", "```text\n", "> "):
            with self.subTest(prefix=prefix):
                comments = signatures()
                comments[1]["body"] = prefix + comments[1]["body"]
                result, state = self.run_audit(comments=[comments])
                self.assert_conclusion(result, state, "failure")

    def test_signature_evidence_and_period_are_accepted(self):
        comments = signatures()
        for item in comments:
            item["body"] += ".\r\n\r\nEvidence: checked the full diff."
        result, state = self.run_audit(comments=[comments])
        self.assert_conclusion(result, state, "success")

    def test_current_write_access_is_required(self):
        for permission in ("none", "read", "triage"):
            with self.subTest(permission=permission):
                result, state = self.run_audit(permissions={"maintainer": permission})
                self.assert_conclusion(result, state, "failure")
        for permission in ("write", "maintain", "admin"):
            with self.subTest(permission=permission):
                result, state = self.run_audit(permissions={"maintainer": permission})
                self.assert_conclusion(result, state, "success")

    def test_bot_or_missing_identity_cannot_sign(self):
        for user in ({"login": "maintainer", "type": "Bot"}, None):
            with self.subTest(user=user):
                comments = signatures()
                comments[1]["user"] = user
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

    def test_newer_changes_requested_withdraws_older_review(self):
        comments = signatures()
        review = {**comments[1], "id": 10, "state": "APPROVED", "commit_id": HEAD}
        adverse = {**review, "id": 11, "state": "CHANGES_REQUESTED", "body": "Regression found"}
        result, state = self.run_audit(comments=[comments[:1] + comments[2:]], reviews=[[review, adverse]])
        self.assert_conclusion(result, state, "failure")
        refreshed = {**review, "id": 12, "state": "COMMENTED"}
        result, state = self.run_audit(comments=[comments[:1] + comments[2:]], reviews=[[review, adverse, refreshed]])
        self.assert_conclusion(result, state, "success")

    def existing_check(self):
        return {"id": 80, "name": "quorum-audit", "head_sha": HEAD,
                "external_id": f"quorum-audit:pr-22:{HEAD}",
                "app": {"slug": "github-actions"},
                "status": "completed", "conclusion": "success",
                "started_at": "2000-01-01T00:00:00Z", "completed_at": "2000-01-01T00:00:01Z",
                "details_url": "https://github.com/old/run"}

    def test_submission_time_controls_pending_review_order(self):
        comments = signatures()
        review = {**comments[1], "id": 10, "state": "APPROVED", "commit_id": HEAD,
                  "submitted_at": "2026-10-01T06:00:00Z"}
        adverse = {**review, "id": 9, "state": "CHANGES_REQUESTED", "body": "Found regression",
                   "submitted_at": "2026-10-01T06:01:00Z"}
        result, state = self.run_audit(comments=[comments[:1] + comments[2:]], reviews=[[adverse, review]])
        self.assert_conclusion(result, state, "failure")

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

    def test_reuse_refreshes_run_provenance(self):
        result, state = self.run_audit(checks=[self.existing_check()])
        self.assert_conclusion(result, state, "success")
        check = state["checks"][0]
        self.assertEqual(check["details_url"], "https://github.com/test/repo/actions/runs/456")
        self.assertNotEqual(check["started_at"], "2000-01-01T00:00:00Z")
        self.assertNotEqual(check["completed_at"], "2000-01-01T00:00:01Z")
        self.assertIn("run_attempt=2", check["output"]["summary"])
        self.assertIn("[Publisher run](https://github.com/test/repo/actions/runs/456)", check["output"]["summary"])
        self.assertIn(f"source_revision={OLD_HEAD}", check["output"]["summary"])

    def test_unmanaged_legacy_check_is_preserved(self):
        legacy = {**self.existing_check(), "external_id": "", "conclusion": "failure"}
        result, state = self.run_audit(checks=[legacy])
        self.assert_conclusion(result, state, "success")
        self.assertEqual(state["checks"][0], legacy)
        self.assertEqual(len(state["checks"]), 2)

    def test_read_failures_invalidate_previous_success(self):
        for failure in ("fail_comments", "fail_reviews", "fail_permissions"):
            with self.subTest(failure=failure):
                result, state = self.run_audit(checks=[self.existing_check()], **{failure: True})
                self.assert_conclusion(result, state, "failure")
                self.assertEqual(state["checks"][0]["output"]["title"], "Quorum audit could not complete")
                self.assertIn("[Publisher run](https://github.com/test/repo/actions/runs/456)", state["checks"][0]["output"]["summary"])

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

    def test_dispatch_requires_matching_expected_head(self):
        result, state = self.run_audit(audit_env={"GITHUB_EVENT_NAME": "workflow_dispatch", "EXPECTED_HEAD": OLD_HEAD})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(state.get("checks"))
        result, state = self.run_audit(audit_env={"GITHUB_EVENT_NAME": "workflow_dispatch", "EXPECTED_HEAD": HEAD})
        self.assert_conclusion(result, state, "success")

    def test_stale_observer_does_not_touch_current_head(self):
        result, state = self.run_audit(audit_env={"SOURCE_HEAD": OLD_HEAD}, checks=[self.existing_check()])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(state["checks"][0], self.existing_check())

    def test_merged_pr_can_verify_default_branch_rollout(self):
        result, state = self.run_audit(pr_state="closed", merged=True)
        self.assert_conclusion(result, state, "success")
        result, state = self.run_audit(pr_state="closed", merged=False)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(state.get("checks"))

    def observer_event(self, prs=None):
        return {"workflow_run": {"event": "pull_request_review",
                "path": ".github/workflows/quorum-review-events.yml",
                "repository": {"full_name": "test/repo"}, "head_sha": HEAD,
                "pull_requests": [{"number": 22}] if prs is None else prs}}

    def test_observer_resolves_pr_and_fork_fallback(self):
        for prs in (None, []):
            with self.subTest(prs=prs):
                result, state = self.run_audit(audit_env={"GITHUB_EVENT_NAME": "workflow_run"},
                    event=self.observer_event(prs), step="Resolve review event without consuming PR artifacts")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("prs=[22]", state["outputs"])
                self.assertIn(f"source_head={HEAD}", state["outputs"])

    def test_unrelated_observer_metadata_is_rejected(self):
        for field, value in (("event", "push"), ("path", "attacker.yml"),
                             ("repository", {"full_name": "attacker/repo"})):
            with self.subTest(field=field):
                event = self.observer_event()
                event["workflow_run"][field] = value
                result, state = self.run_audit(audit_env={"GITHUB_EVENT_NAME": "workflow_run"},
                    event=event, step="Resolve review event without consuming PR artifacts")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(state.get("checks"))

    def test_observer_fallback_can_resolve_merged_rollout_pr(self):
        result, state = self.run_audit(audit_env={"GITHUB_EVENT_NAME": "workflow_run"},
            event=self.observer_event([]), step="Resolve review event without consuming PR artifacts",
            associated_prs=[[{"number": 22, "state": "closed", "merged_at": "2026-10-01T07:00:00Z",
                             "base": {"ref": "main"}}]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("prs=[22]", state["outputs"])


if __name__ == "__main__":
    unittest.main()
