import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
};

/** Serves a local page that renders both models from fixed cameras and scores the difference. */
export async function startCompare(original, compressed, { port }) {
  let threeRoot;
  try {
    // three's "exports" hides package.json; its main entry lives in <root>/build/.
    threeRoot = path.resolve(path.dirname(createRequire(import.meta.url).resolve('three')), '..');
  } catch {
    throw new Error('compare needs the optional "three" package: npm install three');
  }
  const page = fileURLToPath(new URL('./compare/index.html', import.meta.url));
  const files = { '/a.glb': path.resolve(original), '/b.glb': path.resolve(compressed) };
  const meta = {
    a: { name: path.basename(original), bytes: (await stat(files['/a.glb'])).size },
    b: { name: path.basename(compressed), bytes: (await stat(files['/b.glb'])).size },
  };

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://local');
    if (pathname === '/') return pipe(res, page);
    if (pathname === '/meta.json') return res.writeHead(200, { 'Content-Type': TYPES['.json'] }).end(JSON.stringify(meta));
    if (files[pathname]) return pipe(res, files[pathname]);
    if (pathname.startsWith('/three/')) {
      const file = path.join(threeRoot, decodeURIComponent(pathname.slice('/three/'.length)));
      if (file.startsWith(threeRoot + path.sep)) return pipe(res, file);
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.error(`compare page: http://127.0.0.1:${server.address().port}/  (Ctrl+C to stop)`);
  return server;
}

function pipe(res, file) {
  const stream = createReadStream(file);
  stream.on('open', () => res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }));
  stream.on('error', () => res.writeHead(404).end());
  stream.pipe(res);
}
