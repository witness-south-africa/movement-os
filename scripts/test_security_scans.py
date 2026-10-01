"""Exercise the workflow scan/report steps with offline scanner failures."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
PRIVATE = 'private-source-or-secret-must-not-be-published'
SEMGREP_CLEAN = {'results': [], 'errors': [], 'paths': {'scanned': ['example.py']}}
SEMGREP_FINDING = {
    **SEMGREP_CLEAN,
    'results': [{'path': 'example.py', 'check_id': 'example-rule', 'start': {'line': 1},
                 'extra': {'lines': PRIVATE, 'metavars': {'secret': PRIVATE}}}],
}
GITLEAKS_FINDING = [{'File': 'example.py', 'RuleID': 'example-rule', 'StartLine': 1,
                     'Secret': PRIVATE, 'Match': PRIVATE}]


def workflow_shell(step):
    lines = (ROOT / '.github/workflows/security.yml').read_text().splitlines()
    marker = lines.index(f'      - name: {step}')
    start = lines.index('        run: |', marker) + 1
    body = []
    for line in lines[start:]:
        if line and not line.startswith('          '):
            break
        body.append(line[10:])
    return '\n'.join(body)


FAKE_SCANNER = textwrap.dedent('''\
    #!/usr/bin/env python3
    import os
    from pathlib import Path
    import sys
    tool = os.environ['FAKE_TOOL']
    path = Path(os.environ['RUNNER_TEMP']) / (tool + '-report') / (tool + '.json')
    if 'FAKE_REPORT' in os.environ:
        path.write_text(os.environ['FAKE_REPORT'])
    print('private-source-or-secret-must-not-be-published', file=sys.stderr)
    sys.exit(int(os.environ['FAKE_EXIT']))
''')


class SecurityScanTests(unittest.TestCase):
    def run_scan(self, tool, payload, status=0, raw=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / ('docker' if tool == 'semgrep' else 'gitleaks')
            binary.write_text(FAKE_SCANNER)
            binary.chmod(0o700)
            env = {**os.environ, 'PATH': tmp + os.pathsep + os.environ['PATH'],
                   'RUNNER_TEMP': tmp, 'GITHUB_WORKSPACE': str(ROOT),
                   'FAKE_TOOL': tool, 'FAKE_EXIT': str(status)}
            if payload is not None:
                env['FAKE_REPORT'] = payload if raw else json.dumps(payload)
            step = 'Scan with Semgrep CLI' if tool == 'semgrep' else 'Scan full history with Gitleaks CLI'
            result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', workflow_shell(step)],
                                    cwd=ROOT, env=env, text=True, capture_output=True)
            self.assertNotIn(PRIVATE, result.stdout + result.stderr)
            return result

    def test_completed_clean_scans_succeed(self):
        for tool, payload in [('semgrep', SEMGREP_CLEAN), ('gitleaks', [])]:
            with self.subTest(tool=tool):
                result = self.run_scan(tool, payload)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('findings=0', result.stdout)

    def test_findings_fail_even_if_scanner_returns_zero(self):
        for tool, payload in [('semgrep', SEMGREP_FINDING), ('gitleaks', GITLEAKS_FINDING)]:
            for status in (0, 1):
                with self.subTest(tool=tool, status=status):
                    result = self.run_scan(tool, payload, status)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn('findings=1', result.stdout)
                    self.assertIn('example.py', result.stdout)

    def test_operational_failures_cannot_be_green(self):
        for tool, payload in [('semgrep', SEMGREP_CLEAN), ('gitleaks', [])]:
            for status in (1, 2, 7, 125, 137):
                with self.subTest(tool=tool, status=status):
                    result = self.run_scan(tool, payload, status)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('no clean result', result.stdout)

    def test_missing_malformed_or_wrong_shape_reports_fail(self):
        for tool in ('semgrep', 'gitleaks'):
            for payload in (None, '{bad json', '{}', 'null', '"private report"'):
                with self.subTest(tool=tool, payload=payload):
                    result = self.run_scan(tool, payload, raw=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('no clean result', result.stdout)

    def test_semgrep_report_errors_and_empty_scans_fail(self):
        for payload in ({**SEMGREP_CLEAN, 'errors': [{'message': PRIVATE}]},
                        {**SEMGREP_CLEAN, 'paths': {'scanned': []}},
                        {**SEMGREP_CLEAN, 'paths': {'scanned': [None]}},
                        {**SEMGREP_CLEAN, 'paths': {'scanned': ['']}}):
            with self.subTest(payload=payload):
                self.assertEqual(self.run_scan('semgrep', payload).returncode, 2)

    def test_error_types_are_whitelisted_without_messages_or_arbitrary_fields(self):
        payload = {**SEMGREP_CLEAN, 'errors': [
            {'type': 'ParseError', 'message': PRIVATE, 'path': PRIVATE},
            {'type': PRIVATE, 'message': PRIVATE},
            {'type': {'private': PRIVATE}},
            PRIVATE,
        ]}
        result = self.run_scan('semgrep', payload, 2)
        self.assertEqual(result.returncode, 2)
        self.assertIn('error_types={"ParseError": 1, "other": 3}', result.stdout)

    def test_location_fields_cannot_publish_arbitrary_report_data(self):
        payload = {**SEMGREP_CLEAN, 'results': [
            {'path': 'example.py', 'check_id': 'rule', 'start': {'line': {'secret': PRIVATE}}}]}
        self.assertEqual(self.run_scan('semgrep', payload, 1).returncode, 2)

    def test_untrusted_location_newlines_are_escaped(self):
        payload = {**SEMGREP_CLEAN, 'results': [
            {'path': 'example.py\n::error::injected', 'check_id': 'rule', 'start': {'line': 1}}]}
        result = self.run_scan('semgrep', payload, 1)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('\n::error::', result.stdout)
        self.assertIn('\\n::error::', result.stdout)

    def run_dependency_report(self, outcome='success', missing=False):
        env = {**os.environ, 'REVIEW_OUTCOME': outcome, 'VULNERABLE_CHANGES': '[]',
               'INVALID_LICENSE_CHANGES': '{"unlicensed":[],"unresolved":[],"forbidden":[]}',
               'DENIED_CHANGES': '[]'}
        if missing:
            env['DENIED_CHANGES'] = ''
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c',
                               workflow_shell('Report dependency-review findings count')],
                              cwd=ROOT, env=env, text=True, capture_output=True)

    def test_dependency_review_only_reports_clean_after_successful_complete_outputs(self):
        result = self.run_dependency_report()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('findings: 0', result.stdout)
        for outcome in ('failure', 'cancelled', 'skipped', ''):
            result = self.run_dependency_report(outcome)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('findings: 0', result.stdout)
        result = self.run_dependency_report(missing=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('findings: 0', result.stdout)

    def test_gitleaks_install_rejects_unverified_archive_before_extracting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            curl = root / 'curl'
            curl.write_text('#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\n'
                            'Path(sys.argv[sys.argv.index("--output")+1]).write_bytes(b"bad archive")\n')
            curl.chmod(0o700)
            tar = root / 'tar'
            tar.write_text('#!/bin/sh\ntouch "$RUNNER_TEMP/extracted"\n')
            tar.chmod(0o700)
            env = {**os.environ, 'PATH': tmp + os.pathsep + os.environ['PATH'], 'RUNNER_TEMP': tmp}
            result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c',
                                     workflow_shell('Install free Gitleaks CLI')],
                                    cwd=ROOT, env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'extracted').exists())


if __name__ == '__main__':
    unittest.main()
