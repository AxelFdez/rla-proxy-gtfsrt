import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { filterFeed, parsePrefixes } from './filter.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

const SRC_URL =
  process.env.SRC_URL ?? 'https://proxy-data.zou.maregionsud.fr/GTFS-RT/GTFS-RT_trips_ZOU_express.pb';
const TRIP_PREFIXES = parsePrefixes(process.env.TRIP_PREFIXES ?? 'CFP:');
const PORT = Number(process.env.PORT ?? 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 15000);
const MAX_STALE_MS = Number(process.env.MAX_STALE_MS ?? 120000);
const UPSTREAM_TIMEOUT_MS = 8000;

// Comma-separated, so a key can be rotated by deploying old+new side by side.
const API_KEYS = parsePrefixes(process.env.API_KEYS);

if (TRIP_PREFIXES.length === 0) {
  console.error('TRIP_PREFIXES is empty, refusing to start');
  process.exit(1);
}
if (API_KEYS.length === 0) {
  console.error('API_KEYS is empty, refusing to start (set e.g. API_KEYS=$(openssl rand -hex 24))');
  process.exit(1);
}

// Compare SHA-256 digests so timingSafeEqual gets equal lengths and the
// comparison time does not leak the key.
const digest = (s) => createHash('sha256').update(s).digest();
const API_KEY_DIGESTS = API_KEYS.map(digest);

// Accepted, in order: `x-api-key: <key>`, `Authorization: Bearer <key>`,
// `?api_key=<key>` (for clients that can only be configured with a URL).
function isAuthorized(req, url) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const given = req.headers['x-api-key'] ?? bearer ?? url.searchParams.get('api_key');
  if (typeof given !== 'string' || given === '') return false;
  const d = digest(given);
  return API_KEY_DIGESTS.some((k) => timingSafeEqual(k, d));
}

// Last good filtered feed. fetchedAt = last successful contact with upstream
// (200 or 304), which is what the TTL and MAX_STALE_MS are measured against.
let cache = null; // { body, etag, lastModified, upstreamBytes, upstreamEntities, keptEntities, fetchedAt }
let inflight = null;

function log(fields) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
}

// Count kept trips per start_date, to keep an eye on the start_date lagging
// one day behind (observed on CFP trips). Logged only, never corrected.
function startDates(feed) {
  const counts = {};
  for (const e of feed.entity) {
    const d = e.tripUpdate.trip.startDate || '(none)';
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return counts;
}

async function refresh() {
  const headers = {};
  if (cache?.etag) headers['if-none-match'] = cache.etag;

  let res;
  let bytes;
  try {
    res = await fetch(SRC_URL, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (res.status === 304 && cache) {
      cache.fetchedAt = Date.now();
      log({
        upstream_bytes: 0,
        upstream_entities: cache.upstreamEntities,
        kept_entities: cache.keptEntities,
        output_bytes: cache.body.length,
        upstream_last_modified: cache.lastModified,
        status: 'not_modified',
      });
      return;
    }
    if (res.status !== 200) throw new Error(`upstream HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    // Seen on the real feed: Front Door sometimes serves a 0-byte 200 for ~30 s
    // (blob caught mid-rewrite). Treat it as an upstream failure.
    if (bytes.length === 0) throw new Error('upstream returned an empty body');

    const source = FeedMessage.decode(bytes);
    const filtered = filterFeed(source, TRIP_PREFIXES);
    const body = Buffer.from(FeedMessage.encode(filtered).finish());
    const lastModified = res.headers.get('last-modified');

    cache = {
      body,
      etag: res.headers.get('etag'),
      lastModified,
      upstreamBytes: bytes.length,
      upstreamEntities: source.entity.length,
      keptEntities: filtered.entity.length,
      fetchedAt: Date.now(),
    };
    log({
      upstream_bytes: bytes.length,
      upstream_entities: source.entity.length,
      kept_entities: filtered.entity.length,
      output_bytes: body.length,
      upstream_last_modified: lastModified,
      status: 'ok',
      ...(filtered.entity.length === 0 && {
        warning: `no entity matched prefixes ${TRIP_PREFIXES.join(',')}`,
      }),
      kept_start_dates: startDates(filtered),
    });
  } catch (err) {
    const age = cache ? Date.now() - cache.fetchedAt : null;
    log({
      upstream_bytes: bytes?.length ?? null,
      upstream_entities: null,
      kept_entities: null,
      output_bytes: null,
      upstream_last_modified: res?.headers.get('last-modified') ?? null,
      status: 'error',
      error: err.name === 'TimeoutError' ? `upstream timeout after ${UPSTREAM_TIMEOUT_MS} ms` : err.message,
      cache_age_ms: age,
      serving: age !== null && age < MAX_STALE_MS ? 'stale_cache' : '502',
    });
  }
}

// Returns the cache entry to serve, or null if there is nothing fresh enough.
async function getFeed() {
  if (!cache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
    // Concurrent requests during a refresh share the same upstream fetch.
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    await inflight;
  }
  if (cache && Date.now() - cache.fetchedAt < MAX_STALE_MS) return cache;
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const known = pathname === '/gtfs-rt/cfp.pb' || pathname === '/healthz';

  if (!known) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('method not allowed');
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (!isAuthorized(req, url)) {
    res
      .writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'ApiKey', 'cache-control': 'no-store' })
      .end('missing or invalid API key');
    return;
  }

  const feed = await getFeed();
  if (!feed) {
    res.writeHead(502, { 'cache-control': 'no-store', 'content-length': 0 }).end();
    return;
  }
  res
    .writeHead(200, {
      'content-type': 'application/octet-stream',
      // private: the response is behind an API key, shared caches must not
      // hand it to clients without one.
      'cache-control': 'private, max-age=15',
      'content-length': feed.body.length,
      // Seconds since the proxy last confirmed this data with upstream, so a
      // stale response is never silent for the client either.
      age: Math.floor((Date.now() - feed.fetchedAt) / 1000),
      ...(feed.lastModified && { 'last-modified': feed.lastModified }),
    })
    .end(feed.body);
});

server.listen(PORT, () => {
  log({ status: 'listening', port: PORT, src_url: SRC_URL, trip_prefixes: TRIP_PREFIXES });
});

// Node as PID 1 in Docker ignores SIGTERM by default; exit cleanly instead.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
