import http from 'node:http';
import { shrink } from './shrink.js';
import { parseSize } from './size.js';

const HELP = `glb-shrink service

POST /shrink   body: raw .glb bytes (Content-Type: model/gltf-binary)
  query: maxSize=1MB  preset=balanced  textureSize=2048  format=avif|webp
         keepMetalRough=1  simplify=0.5
  200 → compressed .glb, summary in X-Shrink-* headers, full JSON report in
        X-Shrink-Report (base64)
GET  /healthz

example:
  curl --data-binary @model.glb -H 'Content-Type: model/gltf-binary' \\
       'http://localhost:8080/shrink?maxSize=1MB' -o model.min.glb
`;

/**
 * Jobs run one at a time: sharp already uses every core for a single AVIF encode,
 * so parallel jobs would only add memory pressure.
 */
export function startServer({ port, host, maxUploadBytes, queueLimit = 8 }) {
  let chain = Promise.resolve();
  let pending = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok\n');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/plain', HELP);
      if (req.method !== 'POST' || url.pathname !== '/shrink') return sendJson(res, 404, { error: 'not found' });

      if (pending >= queueLimit) return sendJson(res, 503, { error: 'busy, retry later' });
      const options = readOptions(url.searchParams);
      const body = await readBody(req, maxUploadBytes);

      pending++;
      const job = chain.then(() => shrink(body, options));
      chain = job.catch(() => {}).finally(() => pending--);
      const { glb, report } = await job;

      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': glb.byteLength,
        'X-Shrink-Input-Bytes': report.input.bytes,
        'X-Shrink-Output-Bytes': report.output.bytes,
        'X-Shrink-Preset': report.preset,
        'X-Shrink-Budget-Met': report.budget ? String(report.budget.met) : 'n/a',
        'X-Shrink-Report': Buffer.from(JSON.stringify(report)).toString('base64'),
      });
      res.end(glb);
    } catch (err) {
      sendJson(res, err.status ?? 400, { error: err.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      console.error(`glb-shrink service on http://${host}:${actual}`);
      resolve(server);
    });
  });
}

function readOptions(q) {
  return {
    maxBytes: q.get('maxSize') ? parseSize(q.get('maxSize')) : null,
    preset: q.get('preset') || null,
    textureSize: q.get('textureSize') ? Number(q.get('textureSize')) : undefined,
    format: q.get('format') || 'avif',
    keepMetalRough: ['1', 'true'].includes(q.get('keepMetalRough')),
    simplify: q.get('simplify') ? Number(q.get('simplify')) : null,
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(Object.assign(new Error(`upload larger than ${limit} bytes`), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep draining after the limit so the 413 reaches the client instead of a reset.
      if (size > limit) reject(Object.assign(new Error(`upload larger than ${limit} bytes`), { status: 413 }));
      else chunks.push(chunk);
    });
    req.on('end', () => (size ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error('empty body'))));
    req.on('error', reject);
  });
}

// No "Connection: close" on errors: Node then drains the unread upload, so the client reads
// the 413 instead of hitting a reset socket mid-upload.
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json', JSON.stringify(obj) + '\n');
}
