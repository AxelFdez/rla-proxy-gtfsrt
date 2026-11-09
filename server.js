import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { dropFinishedTrips, filterFeed, mergeFeeds, parseList } from './filter.js';
import { tripRoutesFromGtfs } from './gtfs-static.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

// Each source is "<GTFS-RT TripUpdate URL>|<GTFS static zip URL>". The static
// GTFS gives trip_id -> route_id, since route_id is empty in the ZOU feeds.
const DEFAULT_SOURCES = [
  // ZOU Express (CFP, SNCF, ZOE, MCN)
  'https://proxy-data.zou.maregionsud.fr/GTFS-RT/GTFS-RT_trips_ZOU_express.pb' +
    '|https://www.data.gouv.fr/api/1/datasets/r/1164d75b-4a9f-4c5a-b765-31d861b34fda',
  // ZOU Proximité (ZOP)
  'https://proxy-data.zou.maregionsud.fr/GTFS-RT/GTFS-RT_trips_ZOU_proximite.pb' +
    '|https://www.data.gouv.fr/api/1/datasets/r/9c8116cb-2f1a-4045-b149-c5bf6cae6bef',
].join(',');
const DEFAULT_ROUTE_IDS = [
  'CFP:0-1', 'CFP:0-2',
  'ZOP:600', 'ZOP:602', 'ZOP:620', 'ZOP:622', 'ZOP:632', 'ZOP:637',
  'ZOP:650', 'ZOP:670', 'ZOP:671', 'ZOP:672', 'ZOP:675',
].join(',');

const ROUTE_IDS = new Set(parseList(process.env.ROUTE_IDS ?? DEFAULT_ROUTE_IDS));
const PORT = Number(process.env.PORT ?? 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 15000);
const MAX_STALE_MS = Number(process.env.MAX_STALE_MS ?? 120000);
const GTFS_REFRESH_MS = Number(process.env.GTFS_REFRESH_MS ?? 6 * 3600 * 1000);
const FINISHED_GRACE_MS = Number(process.env.FINISHED_GRACE_MS ?? 30 * 60 * 1000);
const UPSTREAM_TIMEOUT_MS = 8000;
const GTFS_TIMEOUT_MS = 60000;
const GTFS_RETRY_MS = 60000;

// Comma-separated, so a key can be rotated by deploying old+new side by side.
const API_KEYS = parseList(process.env.API_KEYS);

const sources = parseList(process.env.SOURCES ?? DEFAULT_SOURCES).map((s) => {
  const [rtUrl, gtfsUrl] = s.split('|').map((u) => u?.trim());
  if (!rtUrl || !gtfsUrl) {
    console.error(`invalid SOURCES entry "${s}", expected "<gtfs-rt url>|<gtfs zip url>"`);
    process.exit(1);
  }
  return {
    name: new URL(rtUrl).pathname.split('/').pop().replace(/\.pb$/, ''),
    rtUrl,
    gtfsUrl,
    tripRoutes: null, // Map trip_id -> route_id
    gtfsLoadedAt: 0,
    gtfsLastAttempt: 0,
    gtfsInflight: null,
    // Last good filtered feed. fetchedAt = last successful contact with the
    // RT upstream (200 or 304), what CACHE_TTL_MS and MAX_STALE_MS apply to.
    feed: null,
    version: 0,
    etag: null,
    lastModified: null,
    upstreamEntities: null,
    fetchedAt: 0,
    inflight: null,
  };
});

if (ROUTE_IDS.size === 0) {
  console.error('ROUTE_IDS is empty, refusing to start');
  process.exit(1);
}
if (sources.length === 0) {
  console.error('SOURCES is empty, refusing to start');
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

function log(fields) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
}

const errorMessage = (err, timeoutMs) =>
  err.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : err.message;

async function loadGtfs(src) {
  src.gtfsLastAttempt = Date.now();
  try {
    const res = await fetch(src.gtfsUrl, { signal: AbortSignal.timeout(GTFS_TIMEOUT_MS) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const tripRoutes = tripRoutesFromGtfs(zip);
    const wanted = [...tripRoutes.values()].filter((r) => ROUTE_IDS.has(r)).length;
    src.tripRoutes = tripRoutes;
    src.gtfsLoadedAt = Date.now();
    // Force a full RT download so the new mapping applies right away
    // instead of waiting for the upstream feed to change.
    src.etag = null;
    log({ source: src.name, status: 'gtfs_loaded', gtfs_bytes: zip.length, trips: tripRoutes.size, wanted_trips: wanted });
  } catch (err) {
    // Keep the previous mapping, if any: an old trips.txt beats no filter.
    log({ source: src.name, status: 'gtfs_error', error: errorMessage(err, GTFS_TIMEOUT_MS), has_previous: !!src.tripRoutes });
  }
}

function ensureGtfs(src) {
  const now = Date.now();
  const due = !src.tripRoutes
    ? now - src.gtfsLastAttempt >= GTFS_RETRY_MS || src.gtfsLastAttempt === 0
    : now - src.gtfsLoadedAt >= GTFS_REFRESH_MS && now - src.gtfsLastAttempt >= GTFS_RETRY_MS;
  if (due) {
    src.gtfsInflight ??= loadGtfs(src).finally(() => {
      src.gtfsInflight = null;
    });
  }
  // Only block when there is no mapping yet; a periodic reload runs in the background.
  return src.tripRoutes ? undefined : src.gtfsInflight;
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

const finishedCutoff = () => (Date.now() - FINISHED_GRACE_MS) / 1000;

async function refresh(src) {
  await ensureGtfs(src);
  if (!src.tripRoutes) {
    log({ source: src.name, status: 'error', error: 'static GTFS not loaded yet, cannot map trips to routes' });
    return;
  }

  const headers = {};
  if (src.etag && src.feed) headers['if-none-match'] = src.etag;

  let res;
  let bytes;
  try {
    res = await fetch(src.rtUrl, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (res.status === 304 && src.feed) {
      src.fetchedAt = Date.now();
      // An unchanged upstream feed still ages: trips can finish in the meantime.
      const remaining = dropFinishedTrips(src.feed, finishedCutoff());
      if (remaining.entity.length !== src.feed.entity.length) {
        src.feed = remaining;
        src.version += 1;
      }
      log({
        source: src.name,
        upstream_bytes: 0,
        upstream_entities: src.upstreamEntities,
        kept_entities: src.feed.entity.length,
        upstream_last_modified: src.lastModified,
        status: 'not_modified',
      });
      return;
    }
    if (res.status !== 200) throw new Error(`upstream HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    // Seen on the real feeds: Front Door sometimes serves a 0-byte 200 for
    // ~30 s (blob caught mid-rewrite). Treat it as an upstream failure.
    if (bytes.length === 0) throw new Error('upstream returned an empty body');

    const upstream = FeedMessage.decode(bytes);
    const routed = filterFeed(upstream, ROUTE_IDS, src.tripRoutes);
    const feed = dropFinishedTrips(routed, finishedCutoff());
    const unmapped = upstream.entity.filter(
      (e) => e.tripUpdate && !e.tripUpdate.trip?.routeId && !src.tripRoutes.has(e.tripUpdate.trip?.tripId),
    ).length;

    Object.assign(src, {
      feed,
      version: src.version + 1,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      upstreamEntities: upstream.entity.length,
      fetchedAt: Date.now(),
    });
    log({
      source: src.name,
      upstream_bytes: bytes.length,
      upstream_entities: upstream.entity.length,
      kept_entities: feed.entity.length,
      output_bytes: FeedMessage.encode(feed).finish().length,
      upstream_last_modified: src.lastModified,
      status: 'ok',
      // Trips absent from the static GTFS can't be mapped to a route and are
      // dropped; a growing count means the static GTFS is out of date.
      unmapped_entities: unmapped,
      finished_entities: routed.entity.length - feed.entity.length,
      ...(feed.entity.length === 0 && { warning: 'no entity matched ROUTE_IDS' }),
      kept_start_dates: startDates(feed),
    });
  } catch (err) {
    const age = src.feed ? Date.now() - src.fetchedAt : null;
    log({
      source: src.name,
      upstream_bytes: bytes?.length ?? null,
      upstream_entities: null,
      kept_entities: null,
      output_bytes: null,
      upstream_last_modified: res?.headers.get('last-modified') ?? null,
      status: 'error',
      error: errorMessage(err, UPSTREAM_TIMEOUT_MS),
      cache_age_ms: age,
      serving: age !== null && age < MAX_STALE_MS ? 'stale_cache' : 'dropped',
    });
  }
}

let output = null; // { key, body }

// Returns what to serve, or null if no source has data fresh enough.
async function getFeed() {
  await Promise.all(
    sources
      .filter((s) => Date.now() - s.fetchedAt >= CACHE_TTL_MS)
      // Concurrent requests during a refresh share the same upstream fetch.
      .map((s) => (s.inflight ??= refresh(s).finally(() => (s.inflight = null)))),
  );

  const now = Date.now();
  const live = sources.filter((s) => s.feed && now - s.fetchedAt < MAX_STALE_MS);
  if (live.length === 0) return null;

  // Re-encode only when a source got new data or the set of live sources changed.
  const key = live.map((s) => `${s.name}@${s.version}`).join(',');
  if (output?.key !== key) {
    output = { key, body: Buffer.from(FeedMessage.encode(mergeFeeds(live.map((s) => s.feed))).finish()) };
  }
  return {
    body: output.body,
    oldestFetchedAt: Math.min(...live.map((s) => s.fetchedAt)),
    missing: sources.filter((s) => !live.includes(s)).map((s) => s.name),
  };
}

const FEED_PATHS = new Set(['/gtfs-rt/trip-updates.pb', '/gtfs-rt/cfp.pb']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const known = FEED_PATHS.has(pathname) || pathname === '/healthz';

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
      // Seconds since the proxy last confirmed the oldest part of this data
      // with upstream, so a stale response is never silent for the client.
      age: Math.floor((Date.now() - feed.oldestFetchedAt) / 1000),
      // A source down for more than MAX_STALE_MS is left out rather than
      // served stale; say so instead of silently shrinking the feed.
      ...(feed.missing.length && { 'x-missing-sources': feed.missing.join(',') }),
    })
    .end(feed.body);
});

server.listen(PORT, () => {
  log({
    status: 'listening',
    port: PORT,
    route_ids: [...ROUTE_IDS],
    sources: sources.map((s) => ({ name: s.name, rt_url: s.rtUrl, gtfs_url: s.gtfsUrl })),
  });
  // Warm the static GTFS so the first client request doesn't pay for it.
  for (const s of sources) ensureGtfs(s);
});

// Node as PID 1 in Docker ignores SIGTERM by default; exit cleanly instead.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
