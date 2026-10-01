import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workerRequire = createRequire(
  new URL('../packages/extract-api-worker/package.json', import.meta.url),
);
const wranglerRequire = createRequire(workerRequire.resolve('wrangler'));
const miniflareRequire = createRequire(wranglerRequire.resolve('miniflare'));

// Exercise the installed native compiler and bundler, rather than their metadata.
const swc = require('@swc/core');
assert.ok(swc.getBinaryMetadata().target, 'SWC must use its native binding');
const compiled = swc.transformSync('export const value: number = 42;', {
  jsc: { parser: { syntax: 'typescript' } },
});
assert.equal(
  (await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`))
    .value,
  42,
);
const esbuild = wranglerRequire('esbuild');
const bundled = esbuild.transformSync('export const value: number = 42;', {
  loader: 'ts',
  format: 'esm',
});
assert.equal(
  (await import(`data:text/javascript,${encodeURIComponent(bundled.code)}`))
    .value,
  42,
);

// Miniflare pins these packages. Verify the reviewed replacements can perform
// an image transform and serve a real local request through workerd/Undici.
const sharp = miniflareRequire('sharp');
const image = await sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 10, g: 20, b: 30, alpha: 1 },
  },
})
  .resize(2, 2)
  .png()
  .toBuffer({ resolveWithObject: true });
assert.equal(image.info.width, 2);
assert.equal(image.info.height, 2);
assert.equal(image.info.format, 'png');

const { Miniflare } = wranglerRequire('miniflare');
const runtime = new Miniflare({
  modules: true,
  compatibilityDate: '2025-05-17',
  script: `export default {
    fetch(request) {
      return Response.json({ ok: true, method: request.method });
    }
  };`,
});
try {
  const response = await runtime.dispatchFetch('http://localhost/toolchain');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, method: 'GET' });
} finally {
  await runtime.dispose();
}

console.log(
  'Dependency toolchain: native compilers, image transform and local HTTP passed',
);
