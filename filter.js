import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

/**
 * Parse a comma-separated list ("CFP:0-1, ZOP:600") into a clean array.
 */
export function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * route_id of a TripUpdate entity: the one in the feed when set, otherwise the
 * one the static GTFS gives for its trip_id (the ZOU feeds leave it empty).
 */
export function routeIdOf(entity, tripRoutes) {
  const trip = entity.tripUpdate?.trip;
  if (!trip) return undefined;
  return trip.routeId || tripRoutes.get(trip.tripId);
}

/**
 * Keep only the TripUpdate entities whose route is in `routeIds`. The header
 * is reused unchanged and kept entities are not modified. Pure: the input
 * feed is not mutated.
 *
 * @param {import('gtfs-realtime-bindings').transit_realtime.IFeedMessage} feed
 * @param {Set<string>} routeIds
 * @param {Map<string, string>} tripRoutes trip_id -> route_id from the static GTFS
 * @returns {import('gtfs-realtime-bindings').transit_realtime.FeedMessage}
 */
export function filterFeed(feed, routeIds, tripRoutes) {
  const entity = (feed.entity ?? []).filter((e) => routeIds.has(routeIdOf(e, tripRoutes)));
  return FeedMessage.create({ header: feed.header, entity });
}

/**
 * Latest arrival or departure time of a TripUpdate, in epoch seconds, or 0 when
 * none of its stops has an absolute time.
 */
export function lastStopTime(entity) {
  let last = 0;
  for (const stop of entity.tripUpdate?.stopTimeUpdate ?? []) {
    last = Math.max(last, Number(stop.arrival?.time ?? 0), Number(stop.departure?.time ?? 0));
  }
  return last;
}

/**
 * Remove the trips whose last stop is before `cutoffSeconds`. The source feeds
 * keep the previous day's finished trips, and their trip_id comes back every
 * day, so a consumer could apply them to today's trip. A trip with no absolute
 * time is kept: nothing says it is over. Pure: the input feed is not mutated.
 */
export function dropFinishedTrips(feed, cutoffSeconds) {
  const entity = (feed.entity ?? []).filter((e) => {
    const last = lastStopTime(e);
    return last === 0 || last >= cutoffSeconds;
  });
  return FeedMessage.create({ header: feed.header, entity });
}

/**
 * Concatenate the entities of several FULL_DATASET feeds into one. The header
 * is the first feed's, with the oldest timestamp so the merged feed never
 * claims to be fresher than its stalest part.
 */
export function mergeFeeds(feeds) {
  const timestamps = feeds.map((f) => Number(f.header.timestamp ?? 0)).filter((t) => t > 0);
  const header = { ...feeds[0].header };
  if (timestamps.length) header.timestamp = Math.min(...timestamps);
  return FeedMessage.create({ header, entity: feeds.flatMap((f) => f.entity ?? []) });
}
