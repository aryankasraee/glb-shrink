# glb-shrink

Shrinks glTF/GLB models (Meshy and similar exports) for phones and the web. It keeps
the look on a 720p screen and cuts download size and GPU memory by one to two orders of magnitude.

Measured on a Meshy export (68k triangles, 8K + 4K PNG textures):

|                          | original | `glb-shrink --max-size 1MB` |
|--------------------------|----------|-----------------------------|
| download                 | 78.4 MB  | 0.88 MB                     |
| GPU memory (textures)    | 537 MB   | 45 MB                       |
| triangles                | 68,181   | 68,181                      |
| SSIM vs original, 720p full view | 1  | 0.994                     |
| SSIM, 2x zoom            | 1        | 0.978                       |

SSIM ≥ 0.99 is hard to tell apart by eye. At 4x zoom, fine fabric detail softens (SSIM 0.89).

## What it does

1. Reads any GLB, including ones already using Draco, meshopt, WebP or AVIF.
2. Replaces a `metallicRoughness` texture with constant factors when the surface is a rough
   dielectric everywhere (metallic p99 ≤ 0.15 and roughness p10 ≥ 0.6). On the model above
   this changed the render by less than 0.001 SSIM. `--keep-metal-rough` turns it off.
3. Downscales textures to `--texture-size` (default 2048, never upscales) with Lanczos and
   encodes them as AVIF at effort 9:
   1. color textures with 4:2:0 chroma,
   2. normal and data maps with 4:4:4 (normal X/Y live in the chroma planes),
   3. alpha dropped where glTF never reads it (opaque base color, normal, ORM).
4. Compresses geometry with Draco at max compression (edgebreaker, speed 0), 14-bit
   positions, 10-bit normals, UVs sized to the largest texture (13 bits for 2048).
5. With `--max-size`, tries presets from `high` down until the file fits.

Geometry is left alone unless you pass `--simplify`. On the test model, halving triangles
saved 50 KB and cost visible quality, and 68k triangles is light for any current phone.

## Install

Node 20+.

```bash
npm ci
npm link            # optional: puts `glb-shrink` on PATH
```

## CLI

```bash
glb-shrink model.glb --max-size 1MB
glb-shrink model.glb -o out.glb --preset high
glb-shrink model.glb --texture-size 1024 --report report.json
```

| option | default | |
|---|---|---|
| `-o, --output` | `<input>.min.glb` | |
| `-m, --max-size` | none | `1MB`, `900KB` (decimal) or `1MiB` (binary) |
| `-p, --preset` | `balanced` (`high` when `--max-size` is set) | `high`, `balanced`, `compact`, `small`, `tiny`, `minimum` |
| `-t, --texture-size` | `2048` | largest texture edge in px |
| `-f, --format` | `avif` | `webp` for very old devices; bigger files |
| `--keep-metal-rough` | off | |
| `--simplify <ratio>` | off | e.g. `0.5`; error capped at 0.1% of mesh size |
| `--report <file>` | | JSON with per-texture sizes, VRAM, presets tried |

Exit code 2 means the file was written but `--max-size` could not be met even at `minimum`.

### Presets

`[scale of --texture-size, AVIF quality]` per texture kind:

| preset | color | normal | data |
|---|---|---|---|
| high | 1, q78 | 1, q52 | 1, q60 |
| balanced | 1, q70 | 1, q45 | 1, q50 |
| compact | 1, q62 | ½, q70 | ½, q50 |
| small | ½, q75 | ½, q60 | ½, q45 |
| tiny | ½, q60 | ¼, q60 | ¼, q40 |
| minimum | ½, q45 | ¼, q45 | ¼, q35 |

`high` and `balanced` were picked by rendering about 25 variants at 1280×720 and scoring them
against the original. Spending bytes on 2K normal maps beat both 1K normals at higher quality
and smaller base color.

## HTTP service

```bash
docker build -t glb-shrink .
docker run -p 8080:8080 glb-shrink
```

```bash
curl --data-binary @model.glb -H 'Content-Type: model/gltf-binary' \
  'http://localhost:8080/shrink?maxSize=1MB' -o model.min.glb
```

Query parameters mirror the CLI: `maxSize`, `preset`, `textureSize`, `format`,
`keepMetalRough=1`, `simplify`. The response is the GLB, with `X-Shrink-Input-Bytes`,
`X-Shrink-Output-Bytes`, `X-Shrink-Preset`, `X-Shrink-Budget-Met`, and the full JSON report
base64-encoded in `X-Shrink-Report`. `GET /healthz` returns `ok`.

Jobs run one at a time (AVIF encoding already uses every core) with up to 8 waiting; more
returns 503. Uploads over `--max-upload` (default 300MB) return 413. Without Docker:
`glb-shrink serve --port 8080 --host 0.0.0.0`.

Timing: the 78 MB model takes about 40 s natively on an Apple M-series Mac and about 2.5 min
in Docker Desktop on the same machine. Most of it is AVIF effort 9 on the 8K source.

The service has no authentication. Keep it on an internal network or behind your gateway.

## Checking quality

```bash
glb-shrink compare model.glb model.min.glb
```

Opens a local page (`http://127.0.0.1:5290`) that renders both files at 1280×720 from five
fixed cameras (full, side, 2x and 4x zoom), shows them side by side, and scores each view with
SSIM and PSNR. It also reports GPU memory, triangles and load time. It needs the optional
`three` dependency, which `npm ci` installs; the Docker image leaves it out.

## Loading in three.js

The output uses `KHR_draco_mesh_compression` and `EXT_texture_avif`. GLTFLoader reads AVIF
on its own; Draco needs a decoder:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const draco = new DRACOLoader().setDecoderPath('/draco/'); // copy three/examples/jsm/libs/draco/gltf/ here
const loader = new GLTFLoader().setDRACOLoader(draco);
const gltf = await loader.loadAsync('/models/model.min.glb');
```

Serve the decoder files yourself rather than from a CDN if users may not reach it.
Brotli/gzip on the `.glb` saves almost nothing (the content is already compressed); a long
`Cache-Control` helps more.

## Compatibility

1. AVIF needs Safari 16+ (iOS 16+), Chrome/Android WebView 85+, Firefox 93+. Use
   `--format webp` if you must support older devices.
2. Unity glTFast reads neither AVIF nor WebP. For Unity, use KTX2 (for example
   `gltfpack -tc`); this tool doesn't produce it.
3. KTX2 inputs are rejected. Export the model with PNG/JPEG textures.

## Development

```bash
npm test
```

Tests build a small synthetic model and cover presets, the size budget, the metallicRoughness
rule, WebP output, re-compressing an already compressed file, and the HTTP service.
