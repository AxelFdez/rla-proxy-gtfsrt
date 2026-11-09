import { test } from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { dropFinishedTrips, filterFeed, lastStopTime, mergeFeeds, parseList } from '../filter.js';

const { FeedMessage, FeedHeader } = GtfsRealtimeBindings.transit_realtime;

const TIMESTAMP = 1793976192;

function tripEntity(id, tripId, routeId) {
  return {
    id,
    tripUpdate: {
      trip: { tripId, startDate: '20261105', ...(routeId && { routeId }) },
      stopTimeUpdate: [
        { stopSequence: 1, stopId: 'CFP:0-1', arrival: { delay: 60 } },
        { stopSequence: 2, stopId: 'CFP:0-2', departure: { delay: 120 } },
      ],
    },
  };
}

// Build the fixture through encode/decode so the tests see the same object
// shapes (Long timestamps, enum numbers) as a real upstream feed.
function fixture(entities, timestamp = TIMESTAMP) {
  const msg = FeedMessage.create({
    header: {
      gtfsRealtimeVersion: '2.0',
      incrementality: FeedHeader.Incrementality.FULL_DATASET,
      timestamp,
    },
    entity: entities,
  });
  return FeedMessage.decode(FeedMessage.encode(msg).finish());
}

// What trips.txt says; the RT feeds leave route_id empty.
const tripRoutes = new Map([
  ['CFP:261101-2517-4348-1', 'CFP:0-1'],
  ['CFP:261101-2547-4400-1', 'CFP:0-2'],
  ['SNC:FR:ServiceJourney::abc', 'SNC:FR:Line::xyz'],
  ['ZOE:12345', 'ZOE:10'],
  ['MCN:42', 'MCN:1'],
]);

const mixed = () =>
  fixture([
    tripEntity('1', 'CFP:261101-2517-4348-1'),
    tripEntity('2', 'SNC:FR:ServiceJourney::abc'),
    tripEntity('3', 'ZOE:12345'),
    tripEntity('4', 'MCN:42'),
    tripEntity('5', 'CFP:261101-2547-4400-1'),
  ]);

const ids = (feed) => feed.entity.map((e) => e.id);

test('keeps only trips whose static route is wanted', () => {
  const out = filterFeed(mixed(), new Set(['CFP:0-1', 'CFP:0-2']), tripRoutes);
  assert.deepEqual(ids(out), ['1', '5']);
});

test('several routes keep the union', () => {
  const out = filterFeed(mixed(), new Set(parseList('CFP:0-1, MCN:1')), tripRoutes);
  assert.deepEqual(ids(out), ['1', '4']);
});

test('a route_id set in the RT feed wins over the static mapping', () => {
  const src = fixture([tripEntity('1', 'CFP:261101-2517-4348-1', 'CFP:0-2')]);
  assert.deepEqual(ids(filterFeed(src, new Set(['CFP:0-2']), tripRoutes)), ['1']);
  assert.deepEqual(ids(filterFeed(src, new Set(['CFP:0-1']), tripRoutes)), []);
});

test('trips missing from the static GTFS are dropped', () => {
  const src = fixture([tripEntity('1', 'CFP:unknown-trip'), tripEntity('2', 'CFP:261101-2517-4348-1')]);
  assert.deepEqual(ids(filterFeed(src, new Set(['CFP:0-1']), tripRoutes)), ['2']);
});

test('a stop_id equal to a wanted route_id does not make a trip match', () => {
  // tripEntity() puts stops CFP:0-1 and CFP:0-2 on every trip, including SNC.
  const out = filterFeed(mixed(), new Set(['CFP:0-1']), new Map());
  assert.equal(out.entity.length, 0);
});

test('header is identical before and after', () => {
  const src = mixed();
  const out = FeedMessage.decode(FeedMessage.encode(filterFeed(src, new Set(['CFP:0-1']), tripRoutes)).finish());
  assert.equal(out.header.gtfsRealtimeVersion, '2.0');
  assert.equal(out.header.incrementality, FeedHeader.Incrementality.FULL_DATASET);
  assert.equal(Number(out.header.timestamp), TIMESTAMP);
  assert.deepEqual(FeedHeader.toObject(out.header), FeedHeader.toObject(src.header));
});

test('no match yields a valid feed with 0 entities', () => {
  const out = filterFeed(mixed(), new Set(['XYZ:1']), tripRoutes);
  assert.equal(out.entity.length, 0);
  assert.equal(FeedMessage.verify(out), null);
  const decoded = FeedMessage.decode(FeedMessage.encode(out).finish());
  assert.equal(decoded.entity.length, 0);
  assert.equal(Number(decoded.header.timestamp), TIMESTAMP);
});

test('entity without tripUpdate is dropped without error', () => {
  const src = fixture([
    { id: 'v1', vehicle: { trip: { tripId: 'CFP:261101-2517-4348-1' }, vehicle: { id: 'bus' } } },
    { id: 'a1', alert: { headerText: { translation: [{ text: 'hello' }] } } },
    { id: 'empty-trip', tripUpdate: { trip: {} } },
    tripEntity('1', 'CFP:261101-2517-4348-1'),
  ]);
  assert.deepEqual(ids(filterFeed(src, new Set(['CFP:0-1']), tripRoutes)), ['1']);
});

test('input feed is not mutated', () => {
  const src = mixed();
  filterFeed(src, new Set(['CFP:0-1']), tripRoutes);
  assert.equal(src.entity.length, 5);
});

test('round trip decode(encode(filtered)) gives the same entities', () => {
  const filtered = filterFeed(mixed(), new Set(['CFP:0-1', 'MCN:1']), tripRoutes);
  const decoded = FeedMessage.decode(FeedMessage.encode(filtered).finish());
  assert.deepEqual(
    FeedMessage.toObject(decoded, { longs: String }),
    FeedMessage.toObject(filtered, { longs: String }),
  );
});

test('mergeFeeds concatenates entities and keeps the oldest timestamp', () => {
  const a = fixture([tripEntity('a1', 'CFP:1')], TIMESTAMP);
  const b = fixture([tripEntity('b1', 'ZOP:1'), tripEntity('b2', 'ZOP:2')], TIMESTAMP - 20);
  const merged = FeedMessage.decode(FeedMessage.encode(mergeFeeds([a, b])).finish());
  assert.deepEqual(ids(merged), ['a1', 'b1', 'b2']);
  assert.equal(Number(merged.header.timestamp), TIMESTAMP - 20);
  assert.equal(merged.header.gtfsRealtimeVersion, '2.0');
  assert.equal(merged.header.incrementality, FeedHeader.Incrementality.FULL_DATASET);
  assert.equal(Number(a.header.timestamp), TIMESTAMP, 'inputs are not mutated');
});

function timedEntity(id, ...times) {
  return {
    id,
    tripUpdate: {
      trip: { tripId: `CFP:${id}` },
      stopTimeUpdate: times.map((time, i) => ({
        stopId: `CFP:0-${i + 1}`,
        ...(i === times.length - 1 ? { arrival: { time } } : { departure: { time } }),
      })),
    },
  };
}

test('dropFinishedTrips removes only trips whose last stop is before the cutoff', () => {
  const cutoff = TIMESTAMP;
  const src = fixture([
    timedEntity('finished', cutoff - 3600, cutoff - 60),
    timedEntity('running', cutoff - 3600, cutoff + 60),
    timedEntity('exactly-at-cutoff', cutoff - 60, cutoff),
    timedEntity('future', cutoff + 60, cutoff + 120),
  ]);
  assert.deepEqual(ids(dropFinishedTrips(src, cutoff)), ['running', 'exactly-at-cutoff', 'future']);
  assert.equal(src.entity.length, 4, 'input is not mutated');
});

test('dropFinishedTrips looks at the latest stop, whatever the stop order', () => {
  const src = fixture([timedEntity('unordered', TIMESTAMP + 60, TIMESTAMP - 60)]);
  assert.deepEqual(ids(dropFinishedTrips(src, TIMESTAMP)), ['unordered']);
});

test('dropFinishedTrips keeps trips without any absolute time and the header', () => {
  const src = fixture([
    { id: 'delay-only', tripUpdate: { trip: { tripId: 'CFP:1' }, stopTimeUpdate: [{ stopId: 'A', arrival: { delay: 60 } }] } },
    { id: 'no-stops', tripUpdate: { trip: { tripId: 'CFP:2' } } },
  ]);
  assert.equal(lastStopTime(src.entity[0]), 0);
  const out = dropFinishedTrips(src, TIMESTAMP);
  assert.deepEqual(ids(out), ['delay-only', 'no-stops']);
  assert.equal(Number(out.header.timestamp), TIMESTAMP);
});

test('parseList trims and drops empty items', () => {
  assert.deepEqual(parseList(' CFP:0-1 ,,ZOP:600 '), ['CFP:0-1', 'ZOP:600']);
  assert.deepEqual(parseList(undefined), []);
});
