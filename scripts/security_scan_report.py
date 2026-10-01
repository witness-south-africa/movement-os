"""Publish scan counts/locations without source snippets and preserve failures."""

import json
from pathlib import Path
import sys


def report(tool, path, status):
    try:
        data = json.loads(Path(path).read_text())
        if tool == 'semgrep':
            findings, errors = data['results'], data['errors']
            scanned = data['paths']['scanned']
            if not all(isinstance(value, list) for value in (findings, errors, scanned)):
                raise ValueError('invalid report')
            if not scanned:
                raise ValueError('no scanned files')
            locations = [{'file': item['path'], 'rule': item['check_id'],
                          'line': item['start']['line']} for item in findings]
        elif tool == 'gitleaks':
            if not isinstance(data, list):
                raise ValueError('invalid report')
            findings, errors = data, []
            locations = [{'file': item['File'], 'rule': item['RuleID'],
                          'line': item['StartLine']} for item in findings]
        else:
            raise ValueError('unknown tool')
        for location in locations:
            if not all(isinstance(location[key], str) for key in ('file', 'rule')):
                raise ValueError('invalid location')
            if type(location['line']) is not int or location['line'] < 1:
                raise ValueError('invalid line')
        if type(status) is not int or status < 0:
            raise ValueError('invalid status')
    except (OSError, ValueError, TypeError, KeyError):
        print(f'{tool}: missing/invalid scan report; no clean result available')
        return 2

    print(f'{tool}: findings={len(findings)} errors={len(errors)} scanner_exit={status}')
    if tool == 'semgrep':
        print(f'semgrep: scanned_files={len(scanned)}')
    for location in locations:
        # JSON escaping keeps untrusted filenames from injecting workflow commands.
        print(json.dumps(location, ensure_ascii=True))
    if status not in (0, 1) or errors or (status == 1 and not findings):
        print(f'{tool}: scan failed; no clean result available')
        return 2
    return 1 if findings else 0


def main(args=None):
    args = sys.argv[1:] if args is None else args
    if len(args) != 3 or args[0] not in ('semgrep', 'gitleaks'):
        print('Usage: security_scan_report.py <semgrep|gitleaks> <report.json> <exit-code>')
        return 2
    try:
        status = int(args[2])
    except ValueError:
        print('Invalid scanner exit code')
        return 2
    return report(args[0], args[1], status)


if __name__ == '__main__':
    sys.exit(main())
