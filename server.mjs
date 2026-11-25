// Reproduction: fetch() of a whole resource resolves with a truncated body, and no error, when the HTTP
// cache holds a partial (206) entry for it and the server also has a compressed representation.
//
//   node server.mjs      then open http://localhost:8080/ in Chrome
//
// Node 18+, no dependencies, one origin. The server behaves like a CDN that compresses on the fly:
//   * a request that does not accept br is served from the identity representation, ranges honoured (206)
//   * a request that accepts br is served from the br representation: weak ETag, and Range is ignored (200)
//   * If-None-Match is compared weakly, so the identity ETag matches the br representation (304)
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const PORT = +(process.env.PORT || 8080);
const SIZE = 2_000_000;
const CHUNK = 65_536;

// Compressible payload of numbered lines.
let text = '';
for (let i = 0; text.length < SIZE; i++) text += `line ${String(i).padStart(9, '0')}\n`;
const DATA = Buffer.from(text).subarray(0, SIZE);
const BROTLI = zlib.brotliCompressSync(DATA, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
const ETAG = `"${crypto.createHash('md5').update(DATA).digest('hex')}"`;
const LAST_MODIFIED = new Date(Date.now() - 86_400_000).toUTCString();
// FRESH=1 adds an explicit lifetime to the identity responses; by default they rely on heuristic freshness.
const FRESHNESS = process.env.FRESH === '1' ? { 'cache-control': 'max-age=3600' } : {};

const PAGE = `<!doctype html><meta charset="utf-8"><title>Truncated fetch() after a partial cache entry</title>
<pre id="out"></pre>
<script>
const SIZE = ${SIZE}, CHUNK = ${CHUNK};
const say = (s) => { document.getElementById('out').textContent += s + '\\n'; };
(async () => {
  const url = '/file?' + Date.now(); // a fresh cache key per page load

  let r = await fetch(url, { headers: { Range: 'bytes=0-' + (CHUNK - 1) } });
  say('1. fetch with Range: bytes=0-' + (CHUNK - 1) + '  ->  ' + r.status + ', ' + (await r.arrayBuffer()).byteLength + ' bytes');

  r = await fetch(url);
  const body = await r.arrayBuffer();
  say('2. fetch with no Range  ->  ' + r.status + ', Content-Length: ' + r.headers.get('content-length') + ', Content-Encoding: ' + r.headers.get('content-encoding') + ', body ' + body.byteLength + ' bytes');

  const ok = body.byteLength === SIZE;
  say(ok ? 'PASS: received all ' + SIZE + ' bytes' : 'FAIL: expected ' + SIZE + ' bytes, received ' + body.byteLength + ' and no error');
  window.__result = { ok, bytes: body.byteLength, status: r.status, cl: r.headers.get('content-length'), enc: r.headers.get('content-encoding') };
})().catch((e) => { say('ERROR: ' + e); window.__result = { ok: false, error: String(e) }; });
</script>`;

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(PAGE); }
  if (pathname !== '/file') { res.writeHead(404); return res.end(); }

  const range = req.headers.range;
  const acceptsBr = /\bbr\b/.test(req.headers['accept-encoding'] || '');
  const ifNoneMatch = (req.headers['if-none-match'] || '').replace(/^W\//, '');
  const describe = `Range: ${range || '-'}  Accept-Encoding: ${req.headers['accept-encoding'] || '-'}  If-None-Match: ${req.headers['if-none-match'] || '-'}  If-Range: ${req.headers['if-range'] || '-'}`;
  const common = { 'content-type': 'text/plain', 'last-modified': LAST_MODIFIED };

  if (acceptsBr) {
    const br = { ...common, etag: `W/${ETAG}`, vary: 'Accept-Encoding' };
    if (ifNoneMatch === ETAG) { console.log(`${describe}\n   -> 304, ETag W/…`); res.writeHead(304, br); return res.end(); }
    console.log(`${describe}\n   -> 200, br, whole resource`);
    res.writeHead(200, { ...br, 'content-encoding': 'br' });
    return res.end(BROTLI);
  }

  const identity = { ...common, ...FRESHNESS, etag: ETAG, 'accept-ranges': 'bytes' };
  if (range) {
    const [, from, to] = /bytes=(\d+)-(\d*)/.exec(range);
    const start = +from, end = to ? Math.min(+to, SIZE - 1) : SIZE - 1;
    console.log(`${describe}\n   -> 206, identity, bytes ${start}-${end}`);
    res.writeHead(206, { ...identity, 'content-range': `bytes ${start}-${end}/${SIZE}`, 'content-length': end - start + 1 });
    return res.end(DATA.subarray(start, end + 1));
  }
  console.log(`${describe}\n   -> 200, identity`);
  res.writeHead(200, { ...identity, 'content-length': SIZE });
  res.end(DATA);
}).listen(PORT, '127.0.0.1', () => console.log(`open http://localhost:${PORT}/\n`));
