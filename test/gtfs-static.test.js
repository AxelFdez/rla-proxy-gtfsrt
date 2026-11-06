import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseCsv, readZipEntry, tripRoutesFromGtfs } from '../gtfs-static.js';

// Minimal zip writer (local headers + central directory + EOCD), enough to
// build fixtures for readZipEntry without a dependency. CRCs are left at 0:
// the reader does not check them.
function makeZip(files, { method = 8 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const TRIPS = [
  '﻿route_id,service_id,trip_id,trip_headsign',
  'CFP:0-1,S1,CFP:261101-2517-4348-1,"Nice, Gare"',
  'ZOP:600,S2,ZOP:1009797-1055761,"Le ""Menton"""',
  '',
].join('\r\n');

test('reads trip_id -> route_id from a deflated trips.txt', () => {
  const zip = makeZip({ 'agency.txt': 'agency_id\nA\n', 'trips.txt': TRIPS });
  const map = tripRoutesFromGtfs(zip);
  assert.equal(map.size, 2);
  assert.equal(map.get('CFP:261101-2517-4348-1'), 'CFP:0-1');
  assert.equal(map.get('ZOP:1009797-1055761'), 'ZOP:600');
});

test('reads stored entries and entries inside a folder', () => {
  const zip = makeZip({ 'gtfs/trips.txt': TRIPS }, { method: 0 });
  assert.equal(readZipEntry(zip, 'trips.txt').toString(), TRIPS);
});

test('missing file and non-zip input throw', () => {
  assert.throws(() => readZipEntry(makeZip({ 'stops.txt': 'x' }), 'trips.txt'), /not found/);
  assert.throws(() => readZipEntry(Buffer.from('hello world, definitely not a zip'), 'trips.txt'), /not a zip/);
});

test('parseCsv handles quotes, escaped quotes, CRLF and a missing final newline', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n,z'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['', 'z'],
  ]);
});
