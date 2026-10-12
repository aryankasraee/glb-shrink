import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { startServer } from '../src/server.js';
import { shrink } from '../src/shrink.js';
import { parseSize } from '../src/size.js';
import { createIO } from '../src/io.js';

// A 2304px base color (above the 2048 cap), a 1024px normal map and a 512px metallicRoughness map.
async function png(size, fill) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(fill(x, y), (y * size + x) * 3);
  return new Uint8Array(await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
}

async function fixture({ metallic = 0 } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
  const normal = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const uv = doc.createAccessor().setType('VEC2').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));

  const material = doc.createMaterial('mat')
    .setBaseColorTexture(doc.createTexture('base').setMimeType('image/png')
      .setImage(await png(2304, (x, y) => [x / 9, y / 9, 128 + 100 * Math.sin((x + y) / 40)].map(Math.round))))
    .setNormalTexture(doc.createTexture('normal').setMimeType('image/png')
      .setImage(await png(1024, (x, y) => [128 + Math.round(20 * Math.sin(x / 9)), 128, 250])))
    .setMetallicRoughnessTexture(doc.createTexture('mr').setMimeType('image/png')
      .setImage(await png(512, (x) => [0, 220 + (x % 20), metallic])));
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal)
    .setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material);
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

const base = await fixture();

test('parseSize handles decimal and binary units', () => {
  assert.equal(parseSize('1MB'), 1_000_000);
  assert.equal(parseSize('900 KB'), 900_000);
  assert.equal(parseSize('1MiB'), 1_048_576);
  assert.equal(parseSize('512'), 512);
  assert.throws(() => parseSize('1 parsec'));
});

test('default run: AVIF capped at 2048, Draco, flat metallicRoughness replaced', async () => {
  const { glb, report } = await shrink(base);
  assert.ok(glb.byteLength < base.byteLength / 2, `expected a big reduction, got ${glb.byteLength} of ${base.byteLength}`);
  assert.equal(report.preset, 'balanced');

  const doc = await (await createIO()).readBinary(glb);
  const json = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  assert.ok(json.includes('KHR_draco_mesh_compression'));
  assert.ok(json.includes('EXT_texture_avif'));

  const textures = doc.getRoot().listTextures();
  assert.equal(textures.length, 2, 'metallicRoughness texture should be gone');
  assert.ok(textures.every((t) => t.getMimeType() === 'image/avif'));
  const baseOut = report.output.textures.find((t) => t.slots.includes('baseColorTexture'));
  assert.deepEqual([baseOut.width, baseOut.height], [2048, 2048]);

  const mat = doc.getRoot().listMaterials()[0];
  assert.equal(mat.getMetallicRoughnessTexture(), null);
  assert.ok(Math.abs(mat.getRoughnessFactor() - 0.9) < 0.03, `roughness ${mat.getRoughnessFactor()}`);
  assert.equal(report.output.triangles, 2);
});

test('metallic surfaces keep their metallicRoughness texture', async () => {
  const { report } = await shrink(await fixture({ metallic: 255 }), { preset: 'small' });
  assert.equal(report.droppedTextures.length, 0);
  assert.equal(report.output.textures.length, 3);
});

test('budget walks down presets and reports when it cannot be met', async () => {
  const { report } = await shrink(base, { maxBytes: 2_000 });
  assert.equal(report.budget.met, false);
  assert.equal(report.preset, 'minimum');
  assert.equal(report.attempts.length, 6);
});

test('budget stops at the first preset that fits', async () => {
  const high = await shrink(base, { preset: 'high' });
  const { report } = await shrink(base, { maxBytes: high.glb.byteLength + 1 });
  assert.equal(report.preset, 'high');
  assert.equal(report.attempts.length, 1);
});

test('webp output', async () => {
  const { glb } = await shrink(base, { format: 'webp', preset: 'small' });
  const doc = await (await createIO()).readBinary(glb);
  assert.ok(doc.getRoot().listTextures().every((t) => t.getMimeType() === 'image/webp'));
});

test('re-shrinking an already shrunk file works', async () => {
  const once = await shrink(base, { preset: 'small' });
  const twice = await shrink(once.glb, { preset: 'small' });
  assert.ok(twice.glb.byteLength > 0);
});

test('rejects bad options', async () => {
  await assert.rejects(shrink(base, { preset: 'nope' }), /unknown preset/);
  await assert.rejects(shrink(base, { format: 'jpeg' }), /format/);
  await assert.rejects(shrink(base, { simplify: 2 }), /simplify/);
});

test('HTTP service compresses a POSTed GLB', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', maxUploadBytes: 50_000_000 });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${url}/shrink?preset=small`, { method: 'POST', body: base, headers: { 'Content-Type': 'model/gltf-binary' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
  const out = new Uint8Array(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('x-shrink-output-bytes')), out.byteLength);
  const report = JSON.parse(Buffer.from(res.headers.get('x-shrink-report'), 'base64').toString());
  assert.equal(report.preset, 'small');

  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  const bad = await fetch(`${url}/shrink?preset=nope`, { method: 'POST', body: base });
  assert.equal(bad.status, 400);
  const tooBig = await startServer({ port: 0, host: '127.0.0.1', maxUploadBytes: 1000 });
  t.after(() => tooBig.close());
  const big = await fetch(`http://127.0.0.1:${tooBig.address().port}/shrink`, { method: 'POST', body: base });
  assert.equal(big.status, 413);
});
