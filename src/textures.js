import sharp from 'sharp';

sharp.cache(false);

const COLOR_SLOTS = new Set([
  'baseColorTexture',
  'emissiveTexture',
  'diffuseTexture',
  'specularColorTexture',
  'sheenColorTexture',
]);
// Slots whose alpha channel glTF never reads, so it can be dropped before encoding.
const ALPHA_FREE_SLOTS = new Set(['normalTexture', 'metallicRoughnessTexture', 'occlusionTexture', 'emissiveTexture']);

/**
 * 'normal' textures keep full chroma (4:4:4) because X/Y live in the chroma planes.
 * 'color' textures tolerate 4:2:0. Everything else is 'data' and keeps 4:4:4.
 */
export function classify(slots) {
  if (slots.some((s) => /normal/i.test(s))) return 'normal';
  if (slots.length > 0 && slots.every((s) => COLOR_SLOTS.has(s))) return 'color';
  return 'data';
}

export function canDropAlpha(slots, materials) {
  return slots.every((s) => {
    if (ALPHA_FREE_SLOTS.has(s)) return true;
    if (s === 'baseColorTexture') return materials.every((m) => m.getAlphaMode() === 'OPAQUE');
    return false;
  });
}

/**
 * A metallicRoughness texture can be replaced by constant factors when the surface is a rough
 * dielectric everywhere: specular highlights are then dim and wide, so per-texel roughness
 * variation barely shows. Unused atlas space (near-black texels) is ignored.
 */
export async function analyzeMetalRough(image) {
  const { data } = await sharp(image, { limitInputPixels: false })
    .resize(256, 256, { fit: 'fill', kernel: 'nearest' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rough = [];
  const metal = [];
  for (let i = 0; i < data.length; i += 3) {
    if (data[i] + data[i + 1] + data[i + 2] < 8) continue;
    rough.push(data[i + 1] / 255);
    metal.push(data[i + 2] / 255);
  }
  if (rough.length === 0) return { flat: false };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];
  const stats = {
    roughness: mean(rough),
    metallic: mean(metal),
    roughnessP10: pct(rough, 0.1),
    metallicP99: pct(metal, 0.99),
  };
  return { ...stats, flat: stats.metallicP99 <= 0.15 && stats.roughnessP10 >= 0.6 };
}

export async function imageSize(image) {
  const { width, height } = await sharp(image, { limitInputPixels: false }).metadata();
  return { width, height };
}

/**
 * Downscales (never upscales) to fit maxSize and encodes. Lanczos keeps texture detail better
 * than the default filter at 2-4x reductions.
 */
export async function encodeTexture(image, { maxSize, quality, kind, format, dropAlpha }) {
  let pipeline = sharp(image, { limitInputPixels: false });
  if (dropAlpha) pipeline = pipeline.removeAlpha();
  pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  if (format === 'avif') {
    pipeline = pipeline.avif({ quality, effort: 9, chromaSubsampling: kind === 'color' ? '4:2:0' : '4:4:4' });
  } else {
    // Lossy WebP is always 4:2:0, so normal and data maps need a higher quality to hold up.
    const q = Math.min(100, quality + (kind === 'color' ? 12 : 30));
    pipeline = pipeline.webp({ quality: q, effort: 6, smartSubsample: true });
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}
