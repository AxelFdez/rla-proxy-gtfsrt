import { test } from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { filterFeed, parsePrefixes } from '../filter.js';

const { FeedMessage, FeedHeader } = GtfsRealtimeBindings.transit_realtime;

const TIMESTAMP = 1793976192;

function tripEntity(id, tripId) {
  return {
    id,
    tripUpdate: {
      trip: { tripId, startDate: '20261105' },
      stopTimeUpdate: [
        { stopSequence: 1, stopId: 'CFP:0-1', arrival: { delay: 60 } },
        { stopSequence: 2, stopId: 'CFP:0-2', departure: { delay: 120 } },
      ],
    },
  };
}

// Build the fixture through encode/decode so the tests see the same object
// shapes (Long timestamps, enum numbers) as a real upstream feed.
function fixture(entities) {
  const msg = FeedMessage.create({
    header: {
      gtfsRealtimeVersion: '2.0',
      incrementality: FeedHeader.Incrementality.FULL_DATASET,
      timestamp: TIMESTAMP,
    },
    entity: entities,
  });
  return FeedMessage.decode(FeedMessage.encode(msg).finish());
}

const mixed = () =>
  fixture([
    tripEntity('1', 'CFP:261027-2482-4442-1'),
    tripEntity('2', 'SNC:FR:ServiceJourney::abc'),
    tripEntity('3', 'ZOE:12345'),
    tripEntity('4', 'MCN:42'),
    tripEntity('5', 'CFP:261027-2483-4443-1'),
  ]);

const tripIds = (feed) => feed.entity.map((e) => e.tripUpdate.trip.tripId);

test('mixed feed filtered with CFP: keeps only CFP: trips', () => {
  const out = filterFeed(mixed(), ['CFP:']);
  assert.deepEqual(tripIds(out), ['CFP:261027-2482-4442-1', 'CFP:261027-2483-4443-1']);
});

test('several prefixes keep the union', () => {
  const out = filterFeed(mixed(), parsePrefixes('CFP:, MCN:'));
  assert.deepEqual(tripIds(out), ['CFP:261027-2482-4442-1', 'MCN:42', 'CFP:261027-2483-4443-1']);
});

test('header is identical before and after', () => {
  const src = mixed();
  const out = FeedMessage.decode(FeedMessage.encode(filterFeed(src, ['CFP:'])).finish());
  assert.equal(out.header.gtfsRealtimeVersion, '2.0');
  assert.equal(out.header.incrementality, FeedHeader.Incrementality.FULL_DATASET);
  assert.equal(Number(out.header.timestamp), TIMESTAMP);
  assert.deepEqual(FeedHeader.toObject(out.header), FeedHeader.toObject(src.header));
});

test('no match yields a valid feed with 0 entities', () => {
  const out = filterFeed(mixed(), ['XYZ:']);
  assert.equal(out.entity.length, 0);
  assert.equal(FeedMessage.verify(out), null);
  const decoded = FeedMessage.decode(FeedMessage.encode(out).finish());
  assert.equal(decoded.entity.length, 0);
  assert.equal(Number(decoded.header.timestamp), TIMESTAMP);
});

test('entity without tripUpdate is dropped without error', () => {
  const src = fixture([
    { id: 'v1', vehicle: { trip: { tripId: 'CFP:fake' }, vehicle: { id: 'bus' } } },
    { id: 'a1', alert: { headerText: { translation: [{ text: 'hello' }] } } },
    { id: 'empty-trip', tripUpdate: { trip: {} } },
    tripEntity('1', 'CFP:261027-2482-4442-1'),
  ]);
  const out = filterFeed(src, ['CFP:']);
  assert.deepEqual(out.entity.map((e) => e.id), ['1']);
});

test('stop_id CFP:0-1 / CFP:0-2 do not make a non-CFP trip match', () => {
  // tripEntity() puts CFP:0-1 and CFP:0-2 stops on every trip, including SNC.
  const out = filterFeed(mixed(), ['CFP:0-1', 'CFP:0-2']);
  assert.equal(out.entity.length, 0);
});

test('input feed is not mutated', () => {
  const src = mixed();
  filterFeed(src, ['CFP:']);
  assert.equal(src.entity.length, 5);
});

test('round trip decode(encode(filtered)) gives the same entities', () => {
  const filtered = filterFeed(mixed(), ['CFP:', 'MCN:']);
  const decoded = FeedMessage.decode(FeedMessage.encode(filtered).finish());
  assert.deepEqual(
    FeedMessage.toObject(decoded, { longs: String }),
    FeedMessage.toObject(filtered, { longs: String }),
  );
});

test('parsePrefixes trims and drops empty items', () => {
  assert.deepEqual(parsePrefixes(' CFP: ,,MCN: '), ['CFP:', 'MCN:']);
  assert.deepEqual(parsePrefixes(undefined), []);
});
