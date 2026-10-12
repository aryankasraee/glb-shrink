import { EXTTextureAVIF, EXTTextureWebP } from '@gltf-transform/extensions';
import {
  cloneDocument,
  dedup,
  dequantize,
  draco,
  listTextureSlots,
  prune,
  simplify,
  weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { createIO } from './io.js';
import { analyzeMetalRough, canDropAlpha, classify, encodeTexture, imageSize } from './textures.js';

/**
 * Each entry is [scale of --texture-size, encoder quality] per texture kind.
 * 'high' and 'balanced' were tuned by rendering a Meshy model at 1280x720 and comparing
 * against the uncompressed original (SSIM 0.995 and 0.994 for the full view).
 */
export const PRESETS = [
  { name: 'high', color: [1, 78], normal: [1, 52], data: [1, 60] },
  { name: 'balanced', color: [1, 70], normal: [1, 45], data: [1, 50] },
  { name: 'compact', color: [1, 62], normal: [0.5, 70], data: [0.5, 50] },
  { name: 'small', color: [0.5, 75], normal: [0.5, 60], data: [0.5, 45] },
  { name: 'tiny', color: [0.5, 60], normal: [0.25, 60], data: [0.25, 40] },
  { name: 'minimum', color: [0.5, 45], normal: [0.25, 45], data: [0.25, 35] },
];

const REENCODED_EXTENSIONS = new Set([
  'EXT_meshopt_compression',
  'KHR_draco_mesh_compression',
  'KHR_mesh_quantization',
  'EXT_texture_webp',
  'EXT_texture_avif',
]);

const DEFAULTS = {
  maxBytes: null,
  preset: null,
  textureSize: 2048,
  format: 'avif',
  keepMetalRough: false,
  simplify: null,
  log: () => {},
};

/**
 * Shrinks a GLB. With maxBytes set, walks down PRESETS (from 'high', or from `preset`)
 * until the output fits; otherwise uses `preset` (default 'balanced').
 */
export async function shrink(input, options = {}) {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULTS, ...given };
  validate(opts);
  const io = await createIO();
  const doc = await io.readBinary(input);
  const root = doc.getRoot();

  const ktx2 = root.listTextures().filter((t) => t.getMimeType() === 'image/ktx2');
  if (ktx2.length) throw new Error('KTX2 input textures are not supported; export the model with PNG/JPEG textures');

  const before = { bytes: input.byteLength, triangles: countTriangles(doc), textures: await describeTextures(doc) };

  // Inputs that were already compressed: decode once, then re-encode only with what we choose below.
  const used = root.listExtensionsUsed();
  if (used.some((e) => e.extensionName === 'KHR_mesh_quantization')) await doc.transform(dequantize());
  for (const ext of used) if (REENCODED_EXTENSIONS.has(ext.extensionName)) ext.dispose();

  await doc.transform(dedup(), prune());
  if (opts.simplify) {
    opts.log(`simplifying to ${opts.simplify} of vertices`);
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: opts.simplify, error: 0.001 }));
  }

  const dropped = opts.keepMetalRough ? [] : await dropFlatMetalRough(doc, opts.log);

  // Cloning keeps texture order, so index i in `sources` matches index i in every clone.
  const sources = await Promise.all(
    root.listTextures().map(async (texture) => {
      const slots = listTextureSlots(texture);
      const users = root.listMaterials().filter((m) => m.getBaseColorTexture() === texture);
      return {
        name: texture.getName(),
        slots,
        kind: classify(slots),
        dropAlpha: canDropAlpha(slots, users),
        image: texture.getImage(),
      };
    }),
  );

  const cache = new Map();
  const encode = (i, kind, [scale, quality]) => {
    const maxSize = Math.max(64, Math.round(opts.textureSize * scale));
    const key = `${i}|${maxSize}|${quality}`;
    if (!cache.has(key)) {
      const s = sources[i];
      cache.set(key, encodeTexture(s.image, { maxSize, quality, kind, format: opts.format, dropAlpha: s.dropAlpha }));
    }
    return cache.get(key);
  };

  const start = PRESETS.findIndex((p) => p.name === (opts.preset ?? (opts.maxBytes ? 'high' : 'balanced')));
  const attempts = [];
  let result;
  for (let p = start; p < PRESETS.length; p++) {
    const preset = PRESETS[p];
    opts.log(`encoding with preset "${preset.name}"`);
    const candidate = cloneDocument(doc);
    const textures = candidate.getRoot().listTextures();
    const encoded = await Promise.all(sources.map((s, i) => encode(i, s.kind, preset[s.kind])));
    candidate.createExtension(opts.format === 'avif' ? EXTTextureAVIF : EXTTextureWebP).setRequired(true);
    textures.forEach((t, i) => t.setImage(encoded[i].data).setMimeType(`image/${opts.format}`).setURI(''));

    const largest = Math.max(1, ...encoded.map((e) => Math.max(e.width, e.height)));
    await candidate.transform(
      draco({
        method: 'edgebreaker',
        encodeSpeed: 0,
        decodeSpeed: 0,
        quantizePosition: 14,
        quantizeNormal: 10,
        // Enough UV precision for a quarter-texel step on the largest texture.
        quantizeTexcoord: Math.min(16, Math.max(12, Math.ceil(Math.log2(largest)) + 2)),
        quantizeColor: 8,
        quantizeGeneric: 12,
      }),
    );
    const glb = await io.writeBinary(candidate);
    attempts.push({ preset: preset.name, bytes: glb.byteLength });
    result = {
      glb,
      preset: preset.name,
      textures: sources.map((s, i) => ({
        name: s.name,
        slots: s.slots,
        width: encoded[i].width,
        height: encoded[i].height,
        bytes: encoded[i].data.byteLength,
        mimeType: `image/${opts.format}`,
      })),
    };
    if (!opts.maxBytes || glb.byteLength <= opts.maxBytes) break;
  }

  const report = {
    preset: result.preset,
    format: opts.format,
    budget: opts.maxBytes ? { maxBytes: opts.maxBytes, met: result.glb.byteLength <= opts.maxBytes } : null,
    attempts,
    input: { ...before, vramBytes: vram(before.textures) },
    output: {
      bytes: result.glb.byteLength,
      triangles: countTriangles(doc),
      textures: result.textures,
      vramBytes: vram(result.textures),
    },
    droppedTextures: dropped,
  };
  return { glb: result.glb, report };
}

function validate(opts) {
  if (!['avif', 'webp'].includes(opts.format)) throw new Error(`format must be avif or webp, got "${opts.format}"`);
  if (opts.preset && !PRESETS.some((p) => p.name === opts.preset)) {
    throw new Error(`unknown preset "${opts.preset}" (${PRESETS.map((p) => p.name).join(', ')})`);
  }
  if (!(opts.textureSize >= 64 && opts.textureSize <= 16384)) throw new Error('textureSize must be between 64 and 16384');
  if (opts.simplify != null && !(opts.simplify > 0 && opts.simplify < 1)) throw new Error('simplify must be between 0 and 1');
  if (opts.maxBytes != null && !(opts.maxBytes > 0)) throw new Error('maxBytes must be positive');
}

async function dropFlatMetalRough(doc, log) {
  const dropped = [];
  for (const texture of doc.getRoot().listTextures()) {
    const slots = listTextureSlots(texture);
    if (slots.length !== 1 || slots[0] !== 'metallicRoughnessTexture') continue;
    const stats = await analyzeMetalRough(texture.getImage());
    if (!stats.flat) continue;
    for (const m of doc.getRoot().listMaterials()) {
      if (m.getMetallicRoughnessTexture() !== texture) continue;
      m.setMetallicRoughnessTexture(null)
        .setRoughnessFactor(round(m.getRoughnessFactor() * stats.roughness))
        .setMetallicFactor(round(m.getMetallicFactor() * stats.metallic));
    }
    log(`dropped flat metallicRoughness texture "${texture.getName()}" (roughness ${round(stats.roughness)})`);
    dropped.push({ name: texture.getName(), slot: slots[0], roughness: round(stats.roughness), metallic: round(stats.metallic) });
    texture.dispose();
  }
  return dropped;
}

async function describeTextures(doc) {
  return Promise.all(
    doc.getRoot().listTextures().map(async (t) => ({
      name: t.getName(),
      slots: listTextureSlots(t),
      ...(await imageSize(t.getImage())),
      bytes: t.getImage().byteLength,
      mimeType: t.getMimeType(),
    })),
  );
}

function countTriangles(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const count = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
      n += count / 3;
    }
  }
  return n;
}

// RGBA8 upload plus a full mip chain; AVIF/WebP are decoded before upload, so file size doesn't matter here.
function vram(textures) {
  return Math.round(textures.reduce((s, t) => s + t.width * t.height * 4 * (4 / 3), 0));
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
