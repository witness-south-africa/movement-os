"""Reject partial source inventories and bind reports to the checked-out revision."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def locked_packages(text):
    # This deliberately supports the reviewed single-document pnpm v9 layout.
    # Unknown layouts fail rather than silently inventorying another YAML document.
    lines = text.splitlines()
    if not lines or lines[0] != "lockfileVersion: '9.0'" or any(
            line in ('---', '...') for line in lines):
        raise ValueError('Unsupported pnpm lockfile layout')
    if lines.count('packages:') != 1:
        raise ValueError('Missing or duplicate locked package inventory')
    entries = set()
    for line in lines[lines.index('packages:') + 1:]:
        if line and not line.startswith(' '):
            break
        if not line.strip() or not line.startswith('  ') or line.startswith('   '):
            continue
        match = re.fullmatch(r"  (?:'([^']+)'|\"([^\"]+)\"|([^'\" ].*)):", line)
        if not match:
            raise ValueError('Unsupported locked package entry')
        key = next(value for value in match.groups() if value is not None)
        name, version = key.split('(', 1)[0].rsplit('@', 1)
        if not name or not version or (name, version) in entries:
            raise ValueError('Invalid or duplicate locked package identity')
        entries.add((name, version))
    if not entries:
        raise ValueError('Empty locked package inventory')
    return entries


def manifests(root):
    paths = [root / 'package.json', *sorted((root / 'packages').glob('*/package.json'))]
    records = []
    identities = set()
    for path in paths:
        data = json.loads(path.read_text())
        identity = data['name'], data['version']
        if not all(isinstance(value, str) and value for value in identity) or identity in identities:
            raise ValueError('Invalid or duplicate source manifest identity')
        identities.add(identity)
        records.append({'path': path.relative_to(root).as_posix(), 'name': identity[0],
                        'version': identity[1], 'sha256': sha256(path)})
    return identities, records


def npm_identity(purl):
    if not isinstance(purl, str) or not purl.startswith('pkg:npm/'):
        return None
    name, version = purl[len('pkg:npm/'):].split('?', 1)[0].split('#', 1)[0].rsplit('@', 1)
    return unquote(name), unquote(version)


def validate(root, syft, spdx, commit, version):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected full source commit')
    if syft['source']['type'] != 'directory' or syft['source']['name'] != 'movement-os' or syft['source']['version'] != commit:
        raise ValueError('Source revision mismatch')
    if syft['descriptor']['name'] != 'syft' or syft['descriptor']['version'] != version:
        raise ValueError('Generator version mismatch')
    if spdx['spdxVersion'] != 'SPDX-2.3' or spdx['dataLicense'] != 'CC0-1.0' or spdx['SPDXID'] != 'SPDXRef-DOCUMENT':
        raise ValueError('Unsupported SPDX document')
    if f'Tool: syft-{version}' not in spdx['creationInfo']['creators']:
        raise ValueError('SPDX generator mismatch')
    source_id = 'SPDXRef-DocumentRoot-Directory-movement-os'
    sources = [package for package in spdx['packages']
               if package['SPDXID'].startswith('SPDXRef-DocumentRoot-')]
    if len(sources) != 1 or sources[0]['SPDXID'] != source_id or sources[0]['name'] != 'movement-os' or sources[0]['versionInfo'] != commit or sources[0]['primaryPackagePurpose'] != 'FILE':
        raise ValueError('SPDX source revision mismatch')
    descriptions = [relation for relation in spdx['relationships']
                    if relation['spdxElementId'] == 'SPDXRef-DOCUMENT'
                    and relation['relationshipType'] == 'DESCRIBES']
    if len(descriptions) != 1 or descriptions[0]['relatedSpdxElement'] != source_id:
        raise ValueError('SPDX source relationship mismatch')
    expected_lock = locked_packages((root / 'pnpm-lock.yaml').read_text())
    expected_source, records = manifests(root)
    expected = expected_lock | expected_source
    observed = set()
    for package in syft['artifacts']:
        if package['type'] == 'npm':
            identity = package['name'], package['version']
            if npm_identity(package['purl']) != identity:
                raise ValueError('Invalid npm package URL')
            observed.add(identity)
    published = set()
    package_ids = set()
    for package in spdx['packages']:
        if package['SPDXID'] in package_ids:
            raise ValueError('Duplicate SPDX package ID')
        package_ids.add(package['SPDXID'])
        for reference in package.get('externalRefs', []):
            if reference['referenceType'] == 'purl':
                identity = npm_identity(reference['referenceLocator'])
                if identity is not None:
                    if identity != (package['name'], package['versionInfo']):
                        raise ValueError('SPDX npm identity mismatch')
                    published.add(identity)
    for label, inventory in (('Syft', observed), ('SPDX', published)):
        if inventory != expected:
            raise ValueError(f'{label} inventory mismatch: missing={len(expected - inventory)} unexpected={len(inventory - expected)}')
    return {'locked_packages': len(expected_lock), 'source_manifests': records,
            'npm_identities': len(expected), 'syft_packages': len(syft['artifacts']),
            'spdx_packages': len(spdx['packages'])}


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        if len(args) != 1:
            raise ValueError('Usage: verify_sbom.py <report-directory>')
        directory = Path(args[0])
        commit, version = os.environ['SBOM_COMMIT'], os.environ['SYFT_VERSION']
        archive_hash = os.environ['SYFT_ARCHIVE_SHA256']
        if not re.fullmatch(r'[0-9a-f]{64}', archive_hash):
            raise ValueError('Missing generator archive checksum')
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        if actual != commit:
            raise ValueError('Checkout commit mismatch')
        subprocess.run(['git', 'diff', '--quiet', 'HEAD'], cwd=ROOT, check=True)
        paths = [directory / 'movement-os.syft.json', directory / 'movement-os.spdx.json']
        syft, spdx = (json.loads(path.read_text()) for path in paths)
        counts = validate(ROOT, syft, spdx, commit, version)
        ref, event = os.environ['SBOM_REF'], os.environ['GITHUB_EVENT_NAME']
        if event == 'push' and not ref.startswith('refs/tags/'):
            raise ValueError('Push inventory requires a tag ref')
        provenance = {'repository': os.environ['GITHUB_REPOSITORY'], 'commit': commit,
                      'ref': ref, 'tag': ref.removeprefix('refs/tags/') if ref.startswith('refs/tags/') else None,
                      'event': event, 'run_id': os.environ['GITHUB_RUN_ID'],
                      'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
                      'scope': 'source and full lockfile; includes development, optional and platform dependencies',
                      'generator': {'name': 'syft', 'version': version, 'archive_sha256': archive_hash},
                      'lockfile_sha256': sha256(ROOT / 'pnpm-lock.yaml'),
                      'outputs': {path.name: sha256(path) for path in paths}, **counts}
        (directory / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
        print(f'SBOM validated: locked_packages={counts["locked_packages"]} source_manifests={len(counts["source_manifests"])} npm_identities={counts["npm_identities"]} commit={commit}')
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        # Counts and validation reasons are sufficient; never dump input documents.
        print('SBOM validation failed: ' + json.dumps(str(error)), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
