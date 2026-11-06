// Just enough of a GTFS static reader to get trip_id -> route_id out of
// trips.txt, with node built-ins only (no zip or CSV dependency).
import { inflateRawSync } from 'node:zlib';

/**
 * Extract one file from a zip archive held in memory. Matches on the base
 * name so archives with a top-level folder work too.
 */
export function readZipEntry(zip, name) {
  // End of central directory record: last 22 bytes + up to 64 KiB of comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (entryName.split('/').pop() !== name) continue;
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(start, start + compSize);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${method} for ${name}`);
  }
  throw new Error(`${name} not found in zip`);
}

/**
 * RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF, optional BOM.
 * Returns an array of rows, each an array of strings.
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Map trip_id -> route_id from the trips.txt of a GTFS zip.
 */
export function tripRoutesFromGtfs(zip) {
  const [header, ...rows] = parseCsv(readZipEntry(zip, 'trips.txt').toString('utf8'));
  const tripCol = header.indexOf('trip_id');
  const routeCol = header.indexOf('route_id');
  if (tripCol < 0 || routeCol < 0) throw new Error('trips.txt lacks trip_id or route_id');
  return new Map(rows.map((r) => [r[tripCol], r[routeCol]]));
}
