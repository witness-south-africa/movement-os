"""Check the real install guard rejects unsupported installer routes."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PackageManagerTests(unittest.TestCase):
    def test_npm_is_rejected_before_dependency_install_scripts(self):
        config = json.loads((ROOT / 'package.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dependency = root / 'dependency'
            dependency.mkdir()
            (dependency / 'package.json').write_text(json.dumps({
                'name': 'synthetic-install-marker', 'version': '1.0.0',
                'scripts': {'postinstall': 'node marker.cjs'},
            }))
            (dependency / 'marker.cjs').write_text(
                "require('node:fs').writeFileSync(process.env.INSTALL_MARKER, 'ran');\n"
            )
            (root / 'package.json').write_text(json.dumps({
                'name': 'installer-control-fixture', 'version': '1.0.0',
                'private': True, 'engines': config['engines'],
                'dependencies': {'synthetic-install-marker': 'file:./dependency'},
            }))
            (root / '.npmrc').write_text((ROOT / '.npmrc').read_text())
            marker = root / 'executed'
            result = subprocess.run(
                ['npm', 'install', '--offline', '--no-audit', '--no-fund',
                 '--package-lock=false', '--cache', str(root / 'cache')],
                cwd=root, text=True, capture_output=True, check=False,
                env={**os.environ, 'INSTALL_MARKER': str(marker)},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('EBADENGINE', result.stdout + result.stderr)
            self.assertFalse(marker.exists())
            self.assertFalse((root / 'node_modules').exists())

    def test_install_guard(self):
        config = json.loads((ROOT / 'package.json').read_text())
        expected = config['packageManager'].replace('@', '/')
        cases = [(expected + ' npm/? node/v22.15.0', 0),
                 ('pnpm/9.15.9 npm/? node/v22.15.0', 1),
                 ('pnpm/10.22.0 npm/? node/v22.15.0', 1),
                 ('npm/10.9.2 node/v22.15.0', 1),
                 ('npm/11.21.0 node/v22.15.0', 1),
                 ('yarn/1.22.22 npm/?', 1), ('', 1)]
        for agent, status in cases:
            with self.subTest(agent=agent):
                result = subprocess.run(
                    ['node', 'scripts/verify-package-manager.mjs'], cwd=ROOT,
                    env={**os.environ, 'npm_config_user_agent': agent},
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode, status)
                if status:
                    self.assertIn('Use Corepack with', result.stderr)


if __name__ == '__main__':
    unittest.main()
