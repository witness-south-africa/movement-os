"""Source inventory integrity regressions, including stale same-dependency reports."""

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import verify_sbom


COMMIT = 'a' * 40
VERSION = '1.52.0'
SOURCE_ID = 'SPDXRef-DocumentRoot-Directory-movement-os'
LOCK = """lockfileVersion: '9.0'

importers:
  .: {}

packages:
  '@scope/dependency@2.0.0':
    resolution: {integrity: example}
  dependency@1.0.0:
    resolution: {integrity: example}

snapshots:
  dependency@1.0.0: {}
"""


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'pnpm-lock.yaml').write_text(LOCK)
        for path, name in [('package.json', 'movement-os'),
                           ('packages/example/package.json', '@movement/example')]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps({'name': name, 'version': '0.0.0'}))
        identities = [('dependency', '1.0.0'), ('@scope/dependency', '2.0.0'),
                      ('movement-os', '0.0.0'), ('@movement/example', '0.0.0')]
        self.syft = {'source': {'type': 'directory', 'name': 'movement-os', 'version': COMMIT},
                     'descriptor': {'name': 'syft', 'version': VERSION},
                     'artifacts': [{'name': name, 'version': version, 'type': 'npm',
                                    'purl': f'pkg:npm/{name.replace("@", "%40")}@{version}'}
                                   for name, version in identities]}
        self.spdx = {'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0',
                     'SPDXID': 'SPDXRef-DOCUMENT',
                     'creationInfo': {'creators': [f'Tool: syft-{VERSION}']},
                     'packages': [{'name': 'movement-os', 'SPDXID': SOURCE_ID,
                                   'versionInfo': COMMIT, 'primaryPackagePurpose': 'FILE'},
                                  *[{'name': item['name'], 'versionInfo': item['version'],
                                     'SPDXID': f'SPDXRef-Package-{index}',
                                     'externalRefs': [{'referenceType': 'purl',
                                                       'referenceLocator': item['purl']}]}
                                    for index, item in enumerate(self.syft['artifacts'])]],
                     'relationships': [{'spdxElementId': 'SPDXRef-DOCUMENT',
                                        'relationshipType': 'DESCRIBES',
                                        'relatedSpdxElement': SOURCE_ID}]}

    def validate(self):
        return verify_sbom.validate(self.root, self.syft, self.spdx, COMMIT, VERSION)

    def test_complete_inventory_includes_source_manifests_and_hashes(self):
        result = self.validate()
        self.assertEqual(result['locked_packages'], 2)
        self.assertEqual(result['npm_identities'], 4)
        self.assertEqual(len(result['source_manifests']), 2)
        for record in result['source_manifests']:
            self.assertEqual(record['sha256'], verify_sbom.sha256(self.root / record['path']))

    def test_stale_spdx_with_identical_dependencies_is_rejected(self):
        self.spdx['packages'][0]['versionInfo'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'SPDX source revision'):
            self.validate()

    def test_missing_or_duplicate_source_root_is_rejected(self):
        original = copy.deepcopy(self.spdx)
        for packages in [original['packages'][1:],
                         [*original['packages'], copy.deepcopy(original['packages'][0])]]:
            with self.subTest(packages=len(packages)):
                self.spdx['packages'] = packages
                with self.assertRaisesRegex(ValueError, 'SPDX source revision'):
                    self.validate()

    def test_missing_wrong_or_duplicate_describes_relation_is_rejected(self):
        edge = self.spdx['relationships'][0]
        for relationships in [[], [{**edge, 'relatedSpdxElement': 'other'}], [edge, edge]]:
            with self.subTest(relationships=relationships):
                self.spdx['relationships'] = relationships
                with self.assertRaisesRegex(ValueError, 'SPDX source relationship'):
                    self.validate()

    def test_partial_syft_and_spdx_inventories_are_rejected_independently(self):
        for index in range(4):
            for report in ['Syft', 'SPDX']:
                with self.subTest(index=index, report=report):
                    syft, spdx = copy.deepcopy(self.syft), copy.deepcopy(self.spdx)
                    if report == 'Syft':
                        del syft['artifacts'][index]
                    else:
                        del spdx['packages'][index + 1]
                    with self.assertRaisesRegex(ValueError, f'{report} inventory mismatch'):
                        verify_sbom.validate(self.root, syft, spdx, COMMIT, VERSION)

    def test_unexpected_identity_is_rejected(self):
        self.syft['artifacts'].append({'type': 'npm', 'name': 'extra', 'version': '1',
                                       'purl': 'pkg:npm/extra@1'})
        with self.assertRaisesRegex(ValueError, 'unexpected=1'):
            self.validate()

    def test_wrong_package_url_is_rejected_in_each_format(self):
        self.syft['artifacts'][0]['purl'] = 'pkg:npm/dependency@9'
        with self.assertRaisesRegex(ValueError, 'Invalid npm package URL'):
            self.validate()
        self.syft['artifacts'][0]['purl'] = 'pkg:npm/dependency@1.0.0'
        self.spdx['packages'][1]['externalRefs'][0]['referenceLocator'] = 'pkg:npm/dependency@9'
        with self.assertRaisesRegex(ValueError, 'SPDX npm identity mismatch'):
            self.validate()

    def test_stale_syft_and_wrong_tool_versions_are_rejected(self):
        for path, value, message in [('source', 'b' * 40, 'Source revision'),
                                     ('descriptor', '0.0.0', 'Generator version')]:
            with self.subTest(path=path):
                report = copy.deepcopy(self.syft)
                report[path]['version'] = value
                with self.assertRaisesRegex(ValueError, message):
                    verify_sbom.validate(self.root, report, self.spdx, COMMIT, VERSION)
        self.spdx['creationInfo']['creators'] = ['Tool: syft-0.0.0']
        with self.assertRaisesRegex(ValueError, 'SPDX generator'):
            self.validate()

    def test_duplicate_package_id_is_rejected(self):
        self.spdx['packages'][2]['SPDXID'] = self.spdx['packages'][1]['SPDXID']
        with self.assertRaisesRegex(ValueError, 'Duplicate SPDX package'):
            self.validate()

    def test_unsupported_or_partial_lockfile_fails_closed(self):
        invalid = [LOCK.replace("'9.0'", "'10.0'"), LOCK + '\n---\npackages: {}\n',
                   LOCK.replace('packages:', 'other:'), LOCK + '\npackages:\n',
                   "lockfileVersion: '9.0'\npackages:\nsnapshots: {}\n",
                   LOCK.replace('  dependency@1.0.0:', '  unsupported-key:')]
        for text in invalid:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    verify_sbom.locked_packages(text)

    def test_version_change_in_lockfile_requires_matching_reports(self):
        (self.root / 'pnpm-lock.yaml').write_text(LOCK.replace('dependency@1.0.0', 'dependency@1.0.1'))
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            self.validate()

    def test_cli_binds_clean_checkout_tag_and_output_checksums(self):
        for command in [['git', 'init', '--quiet'], ['git', 'add', '.'],
                        ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                         'commit', '--quiet', '-m', 'fixture']]:
            subprocess.run(command, cwd=self.root, check=True, capture_output=True)
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.root, text=True).strip()
        self.syft['source']['version'] = commit
        self.spdx['packages'][0]['versionInfo'] = commit
        report_dir = self.root / 'reports'
        report_dir.mkdir()
        for name, report in [('movement-os.syft.json', self.syft), ('movement-os.spdx.json', self.spdx)]:
            (report_dir / name).write_text(json.dumps(report))
        environment = {'SBOM_COMMIT': commit, 'SYFT_VERSION': VERSION,
                       'SYFT_ARCHIVE_SHA256': 'c' * 64, 'SBOM_REF': 'refs/tags/proof/test',
                       'GITHUB_EVENT_NAME': 'push', 'GITHUB_REPOSITORY': 'test/repo',
                       'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        with patch.object(verify_sbom, 'ROOT', self.root), patch.dict(os.environ, environment), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(verify_sbom.main([str(report_dir)]), 0)
            provenance = json.loads((report_dir / 'provenance.json').read_text())
            self.assertEqual((provenance['commit'], provenance['tag']), (commit, 'proof/test'))
            self.assertEqual(provenance['outputs']['movement-os.spdx.json'],
                             verify_sbom.sha256(report_dir / 'movement-os.spdx.json'))
            with patch.dict(os.environ, {'SBOM_REF': 'refs/heads/main'}):
                self.assertEqual(verify_sbom.main([str(report_dir)]), 1)
            with patch.dict(os.environ, {'SBOM_COMMIT': COMMIT}):
                self.assertEqual(verify_sbom.main([str(report_dir)]), 1)
            (self.root / 'package.json').write_text('{}')
            self.assertEqual(verify_sbom.main([str(report_dir)]), 1)


if __name__ == '__main__':
    unittest.main()
