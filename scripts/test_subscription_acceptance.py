"""Exercise acceptance preflight and provenance without OAuth or provider calls."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/subscription-acceptance.mjs'
MODEL = 'visible-model-1'


class SubscriptionAcceptanceBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.store = self.base / 'fresh-store'
        self.project = self.repo / 'packages/subscription-acceptance'
        (self.project / 'src').mkdir(parents=True)
        (self.repo / 'scripts').mkdir()
        shutil.copyfile(SCRIPT, self.repo / 'scripts/subscription-acceptance.mjs')
        (self.repo / '.gitignore').write_text('node_modules/\ndist/\n')
        (self.repo / 'pnpm-lock.yaml').write_text(
            'lockfileVersion: \'9.0\'\n\nimporters:\n\n  .:\n'
            '    devDependencies:\n      typescript:\n'
            '        specifier: ~5.6.3\n        version: 5.6.3\n'
            '\n  packages/subscription-acceptance: {}\n'
        )
        (self.project / 'package.json').write_text(json.dumps({
            'name': '@wsa/subscription-acceptance', 'type': 'module',
            'dependencies': {},
        }))
        (self.project / 'tsconfig.lib.json').write_text(json.dumps({
            'compilerOptions': {'rootDir': 'src', 'outDir': 'dist'},
            'references': [],
        }))
        self.runner('return {analysisAccepted:true, localCredentialsCleared:true, '
                    'remoteRevocationConfirmed:true, provenance};')
        compiler = self.repo / 'node_modules/typescript'
        (compiler / 'bin').mkdir(parents=True)
        (self.repo / 'node_modules/.pnpm').mkdir()
        shutil.copyfile(self.repo / 'pnpm-lock.yaml',
                        self.repo / 'node_modules/.pnpm/lock.yaml')
        (compiler / 'package.json').write_text('{"version":"5.6.3"}')
        (compiler / 'bin/tsc').write_text("""
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') {
  process.stdout.write('Version 5.6.3\\n');
} else {
  fs.writeFileSync('node_modules/tsc-marker', JSON.stringify(process.argv.slice(2)));
  const project = path.join(process.cwd(), 'packages/subscription-acceptance');
  fs.mkdirSync(path.join(project, 'dist'), {recursive:true});
  fs.copyFileSync(path.join(project, 'src/cli.ts'), path.join(project, 'dist/cli.js'));
}
""")
        self.git('init', '--quiet')
        self.git('config', 'user.name', 'Synthetic bootstrap fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.commit()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, text=True,
                              capture_output=True, check=True).stdout.strip()

    def commit(self):
        self.git('add', '.')
        self.git('commit', '--quiet', '-m', 'Synthetic source fixture')

    def runner(self, body):
        (self.project / 'src/cli.ts').write_text(
            'export async function runCli(options, provenance) {' + body + '}\n'
        )

    def invoke(self, args=None):
        if args is None:
            args = ['--directory', str(self.store), '--hosting', 'local',
                    '--accept-uncapped-output', '--model', MODEL]
        return subprocess.run(
            ['node', str(self.repo / 'scripts/subscription-acceptance.mjs'), *args],
            cwd=self.base, text=True, capture_output=True, check=False,
            timeout=20,
        )

    def rejected(self, result, code, status=1):
        self.assertEqual(result.returncode, status, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, f'Subscription acceptance: {code}\n')
        self.assertNotIn(str(self.repo), result.stderr)
        self.assertNotIn(str(self.store), result.stderr)

    def test_help_and_invalid_arguments_have_no_source_build_or_store_effects(self):
        # A dirty source and missing compiler still permit help and usage errors.
        shutil.rmtree(self.repo / 'node_modules')
        (self.project / 'src/cli.ts').write_text('dirty source')
        help_result = self.invoke(['--help'])
        self.assertEqual(help_result.returncode, 0)
        self.assertIn('Usage: pnpm openai:acceptance', help_result.stdout)
        cases = [[], ['--help', '--unknown'], ['--directory', 'relative'],
                 ['--directory', str(self.store), '--hosting', 'self-hosted',
                  '--accept-uncapped-output'],
                 ['--directory', str(self.store), '--hosting', 'local'],
                 ['--directory', str(self.store), '--hosting', 'local',
                  '--accept-uncapped-output', '--model', 'provider text'],
                 ['--directory', str(self.store), '--hosting', 'local',
                  '--accept-uncapped-output', '--accept-uncapped-output']]
        for args in cases:
            with self.subTest(args=args):
                self.rejected(self.invoke(args), 'invalid_arguments', 2)
        self.assertFalse(self.store.exists())
        self.assertFalse((self.project / 'dist').exists())

    def test_closed_output_pipe_reports_only_finite_error(self):
        process = subprocess.Popen(
            ['node', str(self.repo / 'scripts/subscription-acceptance.mjs'), '--help'],
            cwd=self.base, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        process.stdout.close()
        diagnostic = process.stderr.read()
        process.stderr.close()
        self.assertEqual(process.wait(timeout=20), 1)
        self.assertEqual(diagnostic, 'Subscription acceptance: bootstrap_failed\n')

    def test_rebuild_and_report_bind_clean_source_and_emitted_artifacts(self):
        (self.project / 'dist').mkdir()
        (self.project / 'dist/cli.js').write_text('throw new Error("stale secret");')
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        proof = report['provenance']
        self.assertEqual(proof['sourceRevision'], self.git('rev-parse', 'HEAD'))
        self.assertEqual(proof['sourceTree'], self.git('rev-parse', 'HEAD^{tree}'))
        self.assertEqual(proof['lockSha256'], hashlib.sha256(
            (self.repo / 'pnpm-lock.yaml').read_bytes()).hexdigest())
        self.assertRegex(proof['artifactSha256'], r'^[a-f0-9]{64}$')
        self.assertEqual(proof['artifactCount'], 1)
        self.assertEqual(proof['typescriptVersion'], '5.6.3')
        self.assertEqual(json.loads((self.repo / 'node_modules/tsc-marker').read_text()),
                         ['-b', 'packages/subscription-acceptance/tsconfig.lib.json', '--force'])
        self.assertFalse(self.store.exists())

    def test_dirty_source_and_existing_or_git_store_reject_before_build(self):
        self.store.mkdir()
        self.rejected(self.invoke(), 'fresh_directory_required')
        self.store.rmdir()
        result = self.invoke(['--directory', str(self.repo / 'private-store'),
                              '--hosting', 'local', '--accept-uncapped-output'])
        self.rejected(result, 'directory_inside_git')
        (self.project / 'src/cli.ts').write_text('dirty source')
        self.rejected(self.invoke(), 'source_not_clean')
        self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())

    def test_hidden_index_changes_reject_before_build_and_preserve_flags(self):
        source = 'packages/subscription-acceptance/src/cli.ts'
        original = (self.repo / source).read_text()
        for flag in ['--assume-unchanged', '--skip-worktree']:
            with self.subTest(flag=flag):
                self.git('update-index', flag, source)
                index_before = self.git('ls-files', '-v', source)
                (self.repo / source).write_text('uncommitted source sentinel')
                self.assertEqual(self.git('status', '--porcelain'), '')
                self.rejected(self.invoke(), 'source_bytes_changed')
                self.assertEqual(self.git('ls-files', '-v', source), index_before)
                self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())
                self.assertFalse(self.store.exists())
                (self.repo / source).write_text(original)
                self.git('update-index', flag.replace('--', '--no-', 1), source)

    def test_hidden_runtime_source_changes_suppress_receipt_and_preserve_flags(self):
        source = 'packages/subscription-acceptance/src/cli.ts'
        for flag in ['--assume-unchanged', '--skip-worktree']:
            with self.subTest(flag=flag):
                self.runner('const fs = await import("node:fs/promises"); '
                            f'/* {flag} */ '
                            'await fs.writeFile(new URL("../src/cli.ts", import.meta.url), '
                            '"hidden runtime mutation"); '
                            'return {analysisAccepted:true, localCredentialsCleared:true, '
                            'remoteRevocationConfirmed:true};')
                self.commit()
                original = (self.repo / source).read_text()
                self.git('update-index', flag, source)
                index_before = self.git('ls-files', '-v', source)
                self.rejected(self.invoke(), 'source_bytes_changed')
                self.assertTrue((self.repo / 'node_modules/tsc-marker').exists())
                self.assertEqual(self.git('status', '--porcelain'), '')
                self.assertEqual(self.git('ls-files', '-v', source), index_before)
                self.assertFalse(self.store.exists())
                (self.repo / source).write_text(original)
                self.git('update-index', flag.replace('--', '--no-', 1), source)

    def test_installed_lock_symlink_rejects_before_build(self):
        installed = self.repo / 'node_modules/.pnpm/lock.yaml'
        replacement = self.base / 'outside-lock.yaml'
        shutil.copyfile(installed, replacement)
        installed.unlink()
        installed.symlink_to(replacement)
        self.rejected(self.invoke(), 'dependency_not_installed')
        self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())
        self.assertFalse(self.store.exists())

    def test_installed_lock_fifo_rejects_without_waiting_for_writer(self):
        installed = self.repo / 'node_modules/.pnpm/lock.yaml'
        installed.unlink()
        os.mkfifo(installed, 0o600)
        result = subprocess.run(
            ['node', str(self.repo / 'scripts/subscription-acceptance.mjs'),
             '--directory', str(self.store), '--hosting', 'local',
             '--accept-uncapped-output'],
            cwd=self.base, text=True, capture_output=True, check=False, timeout=3,
        )
        self.rejected(result, 'dependency_not_installed')
        self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())
        self.assertFalse(self.store.exists())

    def test_path_replacement_reads_original_handle_and_suppresses_receipt(self):
        source = self.project / 'src/cli.ts'
        original = source.read_text()
        backup = self.base / 'original-source.ts'
        replacement = self.base / 'outside-source.ts'
        replacement.write_text('replacement credential sentinel')
        observation = self.base / 'handle-observation.json'
        probe = f"""
import fs from 'node:fs';
import {{ syncBuiltinESMExports }} from 'node:module';
import {{ pathToFileURL }} from 'node:url';
const target = {json.dumps(str(source))};
const observationFile = {json.dumps(str(observation))};
const originalText = {json.dumps(original)};
const originalOpen = fs.promises.open;
let observed;
fs.promises.open = async (...args) => {{
  const handle = await originalOpen(...args);
  if (args[0] !== target || observed) return handle;
  observed = {{ noFollow: Boolean(args[1] & fs.constants.O_NOFOLLOW), stableRead:false, closed:false }};
  const stat = handle.stat.bind(handle);
  const read = handle.readFile.bind(handle);
  const close = handle.close.bind(handle);
  handle.stat = async () => {{
    const metadata = await stat();
    await fs.promises.rename(target, {json.dumps(str(backup))});
    await fs.promises.symlink({json.dumps(str(replacement))}, target);
    return metadata;
  }};
  handle.readFile = async (...readArgs) => {{
    const contents = await read(...readArgs);
    observed.stableRead = contents.toString('utf8') === originalText;
    return contents;
  }};
  handle.close = async () => {{
    await close();
    observed.closed = true;
    await fs.promises.writeFile(observationFile, JSON.stringify(observed));
  }};
  return handle;
}};
syncBuiltinESMExports();
const module = await import(pathToFileURL({json.dumps(str(self.repo / 'scripts/subscription-acceptance.mjs'))}).href);
try {{
  await module.runBootstrap(['--directory', {json.dumps(str(self.store))}, '--hosting', 'local', '--accept-uncapped-output']);
  process.stdout.write('unexpected receipt');
}} catch {{
  process.stderr.write('finite race rejection\\n');
  process.exitCode = 1;
}}
"""
        result = subprocess.run(['node', '--input-type=module', '-e', probe],
                                cwd=self.base, text=True, capture_output=True,
                                check=False, timeout=20)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, 'finite race rejection\n')
        self.assertEqual(json.loads(observation.read_text()),
                         {'noFollow': True, 'stableRead': True, 'closed': True})
        self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())
        self.assertFalse(self.store.exists())

    def test_ignored_source_config_and_source_symlink_reject_before_build(self):
        with (self.repo / '.gitignore').open('a') as stream:
            stream.write('**/untracked.ts\n/ignored-config.json\n')
        self.commit()
        extra = self.project / 'src/untracked.ts'
        extra.write_text('export const substitute = true;')
        self.rejected(self.invoke(), 'invalid_source_or_artifact')
        extra.unlink()
        config_file = self.project / 'tsconfig.lib.json'
        config = json.loads(config_file.read_text())
        config['extends'] = '../../ignored-config.json'
        config_file.write_text(json.dumps(config))
        self.commit()
        (self.repo / 'ignored-config.json').write_text('{}')
        self.rejected(self.invoke(), 'invalid_source_or_artifact')
        del config['extends']
        config_file.write_text(json.dumps(config))
        self.commit()
        source = self.project / 'src/cli.ts'
        outside = self.base / 'substituted.ts'
        shutil.copyfile(source, outside)
        source.unlink()
        source.symlink_to(outside)
        self.commit()
        self.rejected(self.invoke(), 'invalid_source_or_artifact')
        self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())

    def test_stale_unmapped_output_and_unlocked_compiler_are_rejected(self):
        (self.project / 'dist').mkdir()
        stale = self.project / 'dist/deleted.js'
        stale.write_text('export const deleted = true;')
        self.rejected(self.invoke(), 'invalid_source_or_artifact')
        stale.unlink()
        (self.repo / 'node_modules/typescript/package.json').write_text('{"version":"5.9.3"}')
        self.rejected(self.invoke(), 'toolchain_unavailable')
        (self.repo / 'node_modules/.pnpm/lock.yaml').write_text('outdated installed lock')
        self.rejected(self.invoke(), 'dependency_not_installed')

    def test_real_locked_typescript_build_runs_only_offline_fixture(self):
        installed = subprocess.run(
            ['node', '-e', 'process.stdout.write(require.resolve("typescript/package.json"))'],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        compiler = self.repo / 'node_modules/typescript'
        shutil.rmtree(compiler)
        shutil.copytree(Path(installed.stdout).parent, compiler)
        config = json.loads((self.project / 'tsconfig.lib.json').read_text())
        config['compilerOptions'].update({
            'module': 'NodeNext', 'moduleResolution': 'NodeNext',
            'target': 'ES2023', 'composite': True,
            'declaration': True, 'declarationMap': True, 'types': [],
            'tsBuildInfoFile': 'dist/tsconfig.lib.tsbuildinfo',
        })
        (self.project / 'tsconfig.lib.json').write_text(json.dumps(config))
        self.commit()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report['analysisAccepted'])
        self.assertEqual(report['provenance']['artifactCount'], 4)
        self.assertEqual(report['provenance']['typescriptVersion'], '5.6.3')
        self.assertFalse(self.store.exists())

    def test_failure_diagnostics_do_not_export_compiler_or_runtime_messages(self):
        compiler = self.repo / 'node_modules/typescript/bin/tsc'
        compiler.write_text(compiler.read_text().replace(
            "fs.writeFileSync('node_modules/tsc-marker'",
            "throw new Error('raw credential and private-path sentinel');\n"
            "  fs.writeFileSync('node_modules/tsc-marker'"))
        self.rejected(self.invoke(), 'build_failed')
        compiler.write_text(compiler.read_text().replace(
            "throw new Error('raw credential and private-path sentinel');\n  ", ''))
        self.runner('throw new Error("raw provider body and credential sentinel");')
        self.commit()
        self.rejected(self.invoke(), 'bootstrap_failed')

    def test_runtime_source_and_artifact_mutation_invalidate_success(self):
        self.runner('const fs = await import("node:fs/promises"); '
                    'await fs.writeFile(new URL("../src/cli.ts", import.meta.url), "mutated"); '
                    'return {analysisAccepted:true, localCredentialsCleared:true, '
                    'remoteRevocationConfirmed:true};')
        self.commit()
        self.rejected(self.invoke(), 'source_not_clean')
        self.runner('const fs = await import("node:fs/promises"); '
                    'await fs.appendFile(new URL("./cli.js", import.meta.url), "// mutation"); '
                    'return {analysisAccepted:true, localCredentialsCleared:true, '
                    'remoteRevocationConfirmed:true};')
        self.commit()
        self.rejected(self.invoke(), 'source_or_artifacts_changed')

    def test_rotation_pending_does_not_hide_analysis_or_signout_failure(self):
        self.runner('return {analysisAccepted:true, localCredentialsCleared:true, '
                    'remoteRevocationConfirmed:false, refresh:{status:"not_observed"}, provenance};')
        self.commit()
        result = self.invoke()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(json.loads(result.stdout)['remoteRevocationConfirmed'])
        self.assertEqual(result.stderr, '')

    def test_workspace_dependency_from_another_checkout_is_rejected(self):
        dependency = self.repo / 'packages/dependency'
        (dependency / 'src').mkdir(parents=True)
        (dependency / 'src/index.ts').write_text('export const value = true;')
        (dependency / 'package.json').write_text(json.dumps({
            'name': '@wsa/dependency', 'type': 'module', 'dependencies': {},
        }))
        (dependency / 'tsconfig.lib.json').write_text(json.dumps({
            'compilerOptions': {'rootDir': 'src', 'outDir': 'dist'}, 'references': [],
        }))
        manifest = json.loads((self.project / 'package.json').read_text())
        manifest['dependencies'] = {'@wsa/dependency': 'workspace:*'}
        (self.project / 'package.json').write_text(json.dumps(manifest))
        config = json.loads((self.project / 'tsconfig.lib.json').read_text())
        config['references'] = [{'path': '../dependency/tsconfig.lib.json'}]
        (self.project / 'tsconfig.lib.json').write_text(json.dumps(config))
        links = self.project / 'node_modules/@wsa'
        links.mkdir(parents=True)
        outside = self.base / 'another-checkout'
        outside.mkdir()
        (links / 'dependency').symlink_to(outside)
        self.commit()
        self.rejected(self.invoke(), 'dependency_not_installed')
        self.assertFalse((self.repo / 'node_modules/tsc-marker').exists())
        (links / 'dependency').unlink()
        (links / 'dependency').symlink_to(dependency)
        compiler = self.repo / 'node_modules/typescript/bin/tsc'
        compiler.write_text(compiler.read_text().replace(
            "  const project = path.join(process.cwd(), 'packages/subscription-acceptance');",
            "  const dependency = path.join(process.cwd(), 'packages/dependency');\n"
            "  fs.mkdirSync(path.join(dependency, 'dist'), {recursive:true});\n"
            "  fs.copyFileSync(path.join(dependency, 'src/index.ts'), "
            "path.join(dependency, 'dist/index.js'));\n"
            "  const project = path.join(process.cwd(), 'packages/subscription-acceptance');"))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        first = json.loads(result.stdout)['provenance']
        self.assertEqual(first['artifactCount'], 2)
        (dependency / 'src/index.ts').write_text('export const value = false;')
        self.commit()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        second = json.loads(result.stdout)['provenance']
        self.assertNotEqual(first['artifactSha256'], second['artifactSha256'])


if __name__ == '__main__':
    unittest.main()
