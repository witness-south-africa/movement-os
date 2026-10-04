import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const PROJECT = 'packages/subscription-acceptance';
const TYPESCRIPT = '5.6.3';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_FILES = 5000;
const HELP = `Usage: pnpm openai:acceptance --directory /absolute/private-parent/new-store --hosting local --accept-uncapped-output [--model visible-slug]

Use a fresh local store and choose the ChatGPT account in the system browser.
The runner selects a visible model, makes one synthetic analysis, and signs out
its own registration. Refresh is not_observed unless a real refresh is attempted.
Run from a clean checkout after pnpm install --frozen-lockfile. The bootstrap
rebuilds the locked source and records the artifacts used. --help has no effects.
`;

class BootstrapError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => {
  throw new BootstrapError(code);
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeText = (value, limit) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= limit &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) fail('invalid_arguments');
    seen.add(flag);
    if (flag === '--accept-uncapped-output') {
      options.acceptUncappedOutput = true;
    } else if (['--directory', '--hosting', '--model'].includes(flag)) {
      const value = args[++index];
      if (!safeText(value, flag === '--directory' ? 4096 : 256)) {
        fail('invalid_arguments');
      }
      options[flag.slice(2)] = value;
    } else {
      fail('invalid_arguments');
    }
  }
  if (
    !options.acceptUncappedOutput ||
    options.hosting !== 'local' ||
    !options.directory ||
    !path.isAbsolute(options.directory) ||
    path.dirname(options.directory) === options.directory
  ) {
    fail('invalid_arguments');
  }
  if (
    options.model !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(options.model)
  ) {
    fail('invalid_arguments');
  }
  return options;
}

async function command(file, args, cwd, failure, timeout = 15000) {
  try {
    return (
      await execute(file, args, {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      })
    ).stdout;
  } catch {
    fail(failure);
  }
}

async function boundedRead(file, limit = MAX_FILE_BYTES) {
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > limit
  ) {
    fail('invalid_source_or_artifact');
  }
  const data = await readFile(file);
  if (data.byteLength > limit) fail('invalid_source_or_artifact');
  return data;
}

async function jsonFile(file) {
  try {
    return JSON.parse((await boundedRead(file, 1024 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    fail('invalid_source_or_artifact');
  }
}

async function cleanIdentity(root) {
  const top = (
    await command(
      'git',
      ['rev-parse', '--show-toplevel'],
      root,
      'source_unavailable',
    )
  ).trim();
  if (top !== root) fail('source_unavailable');
  const status = await command(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    root,
    'source_unavailable',
  );
  if (status) fail('source_not_clean');
  const revision = (
    await command(
      'git',
      ['rev-parse', '--verify', 'HEAD'],
      root,
      'source_unavailable',
    )
  ).trim();
  const tree = (
    await command(
      'git',
      ['rev-parse', '--verify', 'HEAD^{tree}'],
      root,
      'source_unavailable',
    )
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{40}$/.test(tree)) {
    fail('source_unavailable');
  }
  const tracked = new Set(
    (await command('git', ['ls-files', '-z'], root, 'source_unavailable'))
      .split('\0')
      .filter(Boolean),
  );
  for (const name of tracked) {
    const metadata = await lstat(path.join(root, name));
    if (
      !safeText(name, 4096) ||
      !metadata.isFile() ||
      metadata.isSymbolicLink()
    ) {
      fail('invalid_source_or_artifact');
    }
  }
  return { revision, tree, tracked };
}

async function freshDirectory(directory) {
  try {
    await lstat(directory);
    fail('fresh_directory_required');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = await realpath(path.dirname(directory));
  try {
    const result = await execute(
      'git',
      ['-C', parent, 'rev-parse', '--is-inside-work-tree'],
      {
        timeout: 15000,
        maxBuffer: 4096,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (result.stdout.trim() === 'true') fail('directory_inside_git');
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    // Git's exit 128 means this existing parent is outside a worktree.
    if (error?.code !== 128) fail('directory_unavailable');
  }
}

async function descendants(directory) {
  const files = [];
  async function visit(current) {
    if (!(await lstat(current)).isDirectory())
      fail('invalid_source_or_artifact');
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!safeText(entry.name, 256) || entry.isSymbolicLink())
        fail('invalid_source_or_artifact');
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(file);
      else fail('invalid_source_or_artifact');
      if (files.length > MAX_GRAPH_FILES) fail('invalid_source_or_artifact');
    }
  }
  await visit(directory);
  return files;
}

async function graphs(root, tracked) {
  const packagesDirectory = path.join(root, 'packages');
  if ((await realpath(packagesDirectory)) !== packagesDirectory)
    fail('invalid_source_or_artifact');
  const projects = new Map();
  for (const entry of await readdir(path.join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !safeText(entry.name, 128)) continue;
    const relative = `packages/${entry.name}`;
    if (!tracked.has(`${relative}/package.json`)) continue;
    if (
      (await realpath(path.join(root, relative))) !== path.join(root, relative)
    )
      fail('invalid_source_or_artifact');
    const manifest = await jsonFile(path.join(root, relative, 'package.json'));
    if (!safeText(manifest.name, 256) || projects.has(manifest.name))
      fail('invalid_source_or_artifact');
    projects.set(manifest.name, { relative, manifest });
  }
  const rootProject = [...projects.values()].find(
    (project) => project.relative === PROJECT,
  );
  if (!rootProject) fail('invalid_source_or_artifact');
  const production = new Set();
  async function runtime(project) {
    if (production.has(project.relative)) return;
    production.add(project.relative);
    for (const [name, version] of Object.entries({
      ...project.manifest.dependencies,
      ...project.manifest.optionalDependencies,
    })) {
      if (typeof version !== 'string') fail('invalid_source_or_artifact');
      if (!version.startsWith('workspace:')) continue;
      const dependency = projects.get(name);
      if (!dependency) fail('invalid_source_or_artifact');
      try {
        const installed = await realpath(
          path.join(root, project.relative, 'node_modules', name),
        );
        if (installed !== path.join(root, dependency.relative))
          fail('dependency_not_installed');
      } catch {
        fail('dependency_not_installed');
      }
      await runtime(dependency);
    }
  }
  await runtime(rootProject);
  const build = new Set();
  const configurations = new Set();
  async function configuration(name) {
    if (configurations.has(name)) return;
    if (!tracked.has(name) || configurations.size > 128)
      fail('invalid_source_or_artifact');
    const file = path.join(root, name);
    if ((await realpath(file)) !== file) fail('invalid_source_or_artifact');
    configurations.add(name);
    const config = await jsonFile(file);
    if (config.extends !== undefined) {
      if (typeof config.extends !== 'string' || !config.extends.startsWith('.'))
        fail('invalid_source_or_artifact');
      const parent = path.resolve(path.dirname(file), config.extends);
      if (!parent.startsWith(`${root}/`) || !parent.endsWith('.json'))
        fail('invalid_source_or_artifact');
      await configuration(path.relative(root, parent));
    }
  }
  async function reference(relative) {
    if (build.has(relative)) return;
    if (!/^packages\/[a-z0-9-]+$/.test(relative) || build.size > 128)
      fail('invalid_source_or_artifact');
    build.add(relative);
    const configName = `${relative}/tsconfig.lib.json`;
    if (!tracked.has(configName)) fail('invalid_source_or_artifact');
    await configuration(configName);
    const config = await jsonFile(path.join(root, configName));
    if (
      config.compilerOptions?.rootDir !== 'src' ||
      config.compilerOptions?.outDir !== 'dist'
    ) {
      fail('invalid_source_or_artifact');
    }
    for (const file of await descendants(path.join(root, relative, 'src'))) {
      if (!tracked.has(path.relative(root, file)))
        fail('invalid_source_or_artifact');
    }
    for (const dependency of config.references ?? []) {
      if (
        !/^\.\.\/[a-z0-9-]+\/tsconfig\.lib\.json$/.test(dependency.path ?? '')
      ) {
        fail('invalid_source_or_artifact');
      }
      await reference(
        path.posix.normalize(`${relative}/${dependency.path}/..`),
      );
    }
  }
  await reference(PROJECT);
  for (const relative of production) {
    if (!build.has(relative)) fail('invalid_source_or_artifact');
  }
  return { production, build };
}

async function compiler(root, lock) {
  const importer = lock
    .toString('utf8')
    .match(/\n {2}\.:(?:\r?\n)([\s\S]*?)(?=\n {2}\S|\n\S|$)/)?.[1];
  const lockedVersion = importer?.match(
    /\n {6}typescript:\r?\n {8}specifier: [^\n]+\r?\n {8}version: ([^\r\n]+)/,
  )?.[1];
  const installed = await realpath(path.join(root, 'node_modules/typescript'));
  if (!installed.startsWith(`${root}/node_modules/`))
    fail('toolchain_unavailable');
  const manifest = await jsonFile(path.join(installed, 'package.json'));
  if (lockedVersion !== TYPESCRIPT || manifest.version !== TYPESCRIPT)
    fail('toolchain_unavailable');
  const binary = await realpath(path.join(installed, 'bin/tsc'));
  if (!binary.startsWith(`${installed}/`)) fail('toolchain_unavailable');
  const version = await command(
    process.execPath,
    [binary, '--version'],
    root,
    'toolchain_unavailable',
  );
  if (version.trim() !== `Version ${TYPESCRIPT}`) fail('toolchain_unavailable');
  return binary;
}

async function installedLock(root, lock) {
  try {
    const installed = await boundedRead(
      path.join(root, 'node_modules/.pnpm/lock.yaml'),
      4 * 1024 * 1024,
    );
    if (digest(installed) !== digest(lock)) fail('dependency_not_installed');
  } catch {
    fail('dependency_not_installed');
  }
}

async function artifactIdentity(root, production, tracked, lock) {
  const entries = [['pnpm-lock.yaml', digest(lock)]];
  let bytes = lock.byteLength;
  let count = 0;
  for (const relative of [...production].sort()) {
    const manifest = await boundedRead(
      path.join(root, relative, 'package.json'),
      1024 * 1024,
    );
    entries.push([`${relative}/package.json`, digest(manifest)]);
    for (const file of (
      await descendants(path.join(root, relative, 'dist'))
    ).sort()) {
      if (!/(\.(js|d\.ts)(\.map)?|\/tsconfig\.lib\.tsbuildinfo)$/.test(file)) {
        fail('invalid_source_or_artifact');
      }
      const name = path.relative(root, file);
      const input = name.endsWith('/tsconfig.lib.tsbuildinfo')
        ? `${relative}/tsconfig.lib.json`
        : name
            .replace('/dist/', '/src/')
            .replace(/\.(js|d\.ts)(\.map)?$/, '.ts');
      if (!tracked.has(input) || /\.(spec|test)\.ts$/.test(input))
        fail('invalid_source_or_artifact');
      const contents = await boundedRead(file);
      bytes += contents.byteLength;
      count += 1;
      if (bytes > MAX_GRAPH_BYTES || count > MAX_GRAPH_FILES)
        fail('invalid_source_or_artifact');
      entries.push([name, digest(contents)]);
    }
  }
  if (!count) fail('invalid_source_or_artifact');
  entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
  return {
    artifactSha256: digest(JSON.stringify(entries)),
    artifactCount: count,
  };
}

export async function runBootstrap(args, scriptUrl = import.meta.url) {
  const options = parseArguments(args);
  if (options.help) return { help: HELP };
  const root = path.dirname(path.dirname(fileURLToPath(scriptUrl)));
  if ((await realpath(root)) !== root) fail('invalid_source_or_artifact');
  await freshDirectory(options.directory);
  const before = await cleanIdentity(root);
  const lock = await boundedRead(
    path.join(root, 'pnpm-lock.yaml'),
    4 * 1024 * 1024,
  );
  await installedLock(root, lock);
  const { production } = await graphs(root, before.tracked);
  const binary = await compiler(root, lock);
  await command(
    process.execPath,
    [binary, '-b', `${PROJECT}/tsconfig.lib.json`, '--force'],
    root,
    'build_failed',
    120000,
  );
  const built = await cleanIdentity(root);
  if (before.revision !== built.revision || before.tree !== built.tree)
    fail('source_changed');
  const artifacts = await artifactIdentity(
    root,
    production,
    built.tracked,
    lock,
  );
  const provenance = {
    sourceRevision: built.revision,
    sourceTree: built.tree,
    lockSha256: digest(lock),
    ...artifacts,
    nodeVersion: process.version,
    typescriptVersion: TYPESCRIPT,
  };
  const module = await import(
    pathToFileURL(path.join(root, PROJECT, 'dist/cli.js')).href
  );
  if (typeof module.runCli !== 'function') fail('invalid_source_or_artifact');
  const report = await module.runCli(options, provenance);
  const after = await cleanIdentity(root);
  await graphs(root, after.tracked);
  const afterLock = await boundedRead(
    path.join(root, 'pnpm-lock.yaml'),
    4 * 1024 * 1024,
  );
  await installedLock(root, afterLock);
  const afterArtifacts = await artifactIdentity(
    root,
    production,
    after.tracked,
    afterLock,
  );
  if (
    built.revision !== after.revision ||
    built.tree !== after.tree ||
    provenance.lockSha256 !== digest(afterLock) ||
    artifacts.artifactSha256 !== afterArtifacts.artifactSha256 ||
    artifacts.artifactCount !== afterArtifacts.artifactCount
  )
    fail('source_or_artifacts_changed');
  return { report };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const onOutputError = () => {
    process.exitCode = 1;
  };
  process.stdout.on('error', onOutputError);
  process.stderr.on('error', onOutputError);
  process.once('beforeExit', () => {
    process.stdout.removeListener('error', onOutputError);
    process.stderr.removeListener('error', onOutputError);
  });
  try {
    const result = await runBootstrap(process.argv.slice(2));
    const output = result.help ?? `${JSON.stringify(result.report)}\n`;
    await new Promise((resolve, reject) =>
      process.stdout.write(output, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (
      result.report &&
      !(
        result.report.analysisAccepted === true &&
        result.report.localCredentialsCleared === true &&
        result.report.remoteRevocationConfirmed === true
      )
    )
      process.exitCode = 1;
  } catch (error) {
    const code =
      error instanceof BootstrapError ? error.code : 'bootstrap_failed';
    process.exitCode = code === 'invalid_arguments' ? 2 : 1;
    await new Promise((resolve) =>
      process.stderr.write(`Subscription acceptance: ${code}\n`, resolve),
    );
  }
}
