#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PRESETS, shrink } from '../src/shrink.js';
import { formatBytes, parseSize } from '../src/size.js';

const USAGE = `glb-shrink — shrink GLB models for mobile web (AVIF textures + Draco geometry)

Usage:
  glb-shrink <input.glb> [options]          compress one file
  glb-shrink serve [--port 8080]            run the HTTP service
  glb-shrink compare <a.glb> <b.glb>        render both and show visual difference

Compress options:
  -o, --output <file>       output path (default: <input>.min.glb)
  -m, --max-size <size>     size budget, e.g. 1MB, 900KB (KB/MB decimal, KiB/MiB binary);
                            steps down through presets until the file fits
  -p, --preset <name>       ${PRESETS.map((p) => p.name).join(' | ')} (default: balanced,
                            or high when --max-size is set)
  -t, --texture-size <px>   largest texture edge (default: 2048)
  -f, --format <fmt>        avif (default) | webp (older devices, bigger files)
      --keep-metal-rough    never replace a flat metallicRoughness texture with constants
      --simplify <ratio>    reduce triangles to this ratio of vertices, e.g. 0.5 (off by default)
      --report <file>       write the JSON report to a file
  -q, --quiet               only print errors

Serve options:
      --port <n>            default: 8080 (env PORT)
      --host <addr>         default: 127.0.0.1 (env HOST)
      --max-upload <size>   default: 300MB

Compare options:
      --port <n>            default: 5290

Exit codes: 0 ok, 1 error, 2 written but --max-size not met.`;

const argv = process.argv.slice(2);
const command = ['serve', 'compare'].includes(argv[0]) ? argv.shift() : 'compress';

try {
  if (command === 'serve') await serve(argv);
  else if (command === 'compare') await compare(argv);
  else process.exitCode = await compress(argv);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}

async function compress(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      'max-size': { type: 'string', short: 'm' },
      preset: { type: 'string', short: 'p' },
      'texture-size': { type: 'string', short: 't' },
      format: { type: 'string', short: 'f' },
      'keep-metal-rough': { type: 'boolean' },
      simplify: { type: 'string' },
      report: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const inputPath = positionals[0];
  const outputPath = values.output ?? inputPath.replace(/\.(glb|gltf)$/i, '') + '.min.glb';
  const say = values.quiet ? () => {} : (m) => console.error(m);

  const started = Date.now();
  const { glb, report } = await shrink(await readFile(inputPath), {
    maxBytes: values['max-size'] ? parseSize(values['max-size']) : null,
    preset: values.preset ?? null,
    textureSize: values['texture-size'] ? Number(values['texture-size']) : undefined,
    format: values.format ?? 'avif',
    keepMetalRough: values['keep-metal-rough'] ?? false,
    simplify: values.simplify ? Number(values.simplify) : null,
    log: (m) => say(`  · ${m}`),
  });
  await writeFile(outputPath, glb);
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2));

  if (!values.quiet) {
    const { input, output } = report;
    console.error(`\n${inputPath} → ${outputPath}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    console.error(`  size       ${formatBytes(input.bytes)} → ${formatBytes(output.bytes)}  (preset ${report.preset})`);
    console.error(`  gpu memory ${formatBytes(input.vramBytes)} → ${formatBytes(output.vramBytes)}`);
    console.error(`  triangles  ${input.triangles} → ${output.triangles}`);
    for (const t of output.textures) {
      console.error(`  texture    ${t.slots.join(',')}: ${t.width}x${t.height} ${t.mimeType} ${formatBytes(t.bytes)}`);
    }
    for (const t of report.droppedTextures) {
      console.error(`  dropped    ${t.slot} (flat; roughness ${t.roughness}, metallic ${t.metallic})`);
    }
  }
  if (report.budget && !report.budget.met) {
    console.error(`warning: smallest preset is ${formatBytes(report.output.bytes)}, over the ${formatBytes(report.budget.maxBytes)} budget`);
    return 2;
  }
  return 0;
}

async function serve(args) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'max-upload': { type: 'string' },
    },
  });
  const { startServer } = await import('../src/server.js');
  await startServer({
    port: Number(values.port ?? process.env.PORT ?? 8080),
    host: values.host ?? process.env.HOST ?? '127.0.0.1',
    maxUploadBytes: parseSize(values['max-upload'] ?? '300MB'),
  });
}

async function compare(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { port: { type: 'string' } } });
  if (positionals.length !== 2) throw new Error('compare needs two files: glb-shrink compare <original.glb> <compressed.glb>');
  const { startCompare } = await import('../src/compare.js');
  await startCompare(positionals[0], positionals[1], { port: Number(values.port ?? 5290) });
}
