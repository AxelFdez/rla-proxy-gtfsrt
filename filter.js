import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

/**
 * Parse a comma-separated prefix list ("CFP:,MCN:") into a clean array.
 */
export function parsePrefixes(value) {
  return String(value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Keep only the entities whose trip_update.trip.trip_id starts with one of
 * `prefixes`. The header is reused unchanged and kept entities are not
 * modified. Pure: the input feed is not mutated.
 *
 * @param {import('gtfs-realtime-bindings').transit_realtime.IFeedMessage} feed
 * @param {string[]} prefixes
 * @returns {import('gtfs-realtime-bindings').transit_realtime.FeedMessage}
 */
export function filterFeed(feed, prefixes) {
  const entity = (feed.entity ?? []).filter((e) => {
    const tripId = e.tripUpdate?.trip?.tripId;
    return typeof tripId === 'string' && prefixes.some((p) => tripId.startsWith(p));
  });
  return FeedMessage.create({ header: feed.header, entity });
}
