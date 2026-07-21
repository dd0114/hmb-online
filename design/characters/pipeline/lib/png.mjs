// PNG 코덱 — 외부 의존 0 (node:zlib 만). RGBA8 Uint8Array 로 주고받는다.
// 결정론: deflate 레벨 고정, 필터 0 고정 → 같은 입력 = 바이트 동일 출력.
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('PNG 시그니처 아님');
  let p = 8;
  let ihdr = null;
  const idat = [];
  let plte = null;
  let trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('IHDR 없음');
  if (ihdr.interlace) throw new Error('인터레이스 PNG 미지원 — 비인터레이스로 다시 저장하세요');
  const { width, height, depth, color } = ihdr;
  if (depth !== 8 && depth !== 16) {
    if (!(color === 3 && (depth === 1 || depth === 2 || depth === 4)))
      throw new Error(`비트깊이 ${depth} 미지원 (8/16bit 또는 팔레트 PNG 만)`);
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`color type ${color} 미지원`);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expected = height * (rowBytes + 1);
  if (raw.length < expected)
    throw new Error(`IDAT 손상: 압축해제 ${raw.length}바이트, ${expected} 필요 (잘린 PNG)`);
  const out = Buffer.alloc(height * rowBytes);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const line = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    line.copy(cur);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }

  const data = new Uint8Array(width * height * 4);
  const s = depth === 16 ? 2 : 1; // 16bit 는 상위 바이트만 사용
  for (let y = 0; y < height; y++) {
    const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        let idx;
        if (depth === 8) idx = row[x];
        else {
          const per = 8 / depth;
          const byte = row[Math.floor(x / per)];
          const shift = 8 - depth * ((x % per) + 1);
          idx = (byte >> shift) & ((1 << depth) - 1);
        }
        data[o] = plte[idx * 3];
        data[o + 1] = plte[idx * 3 + 1];
        data[o + 2] = plte[idx * 3 + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (color === 0) {
        const g = row[x * s];
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = 255;
      } else if (color === 4) {
        const g = row[x * 2 * s];
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = row[(x * 2 + 1) * s];
      } else if (color === 2) {
        data[o] = row[x * 3 * s];
        data[o + 1] = row[(x * 3 + 1) * s];
        data[o + 2] = row[(x * 3 + 2) * s];
        data[o + 3] = 255;
      } else {
        data[o] = row[x * 4 * s];
        data[o + 1] = row[(x * 4 + 1) * s];
        data[o + 2] = row[(x * 4 + 2) * s];
        data[o + 3] = row[(x * 4 + 3) * s];
      }
    }
  }
  return { width, height, data };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG({ width, height, data }) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter none — 픽셀아트는 필터 이득이 적고 결정론이 명확
    Buffer.from(data.buffer, data.byteOffset + y * rowBytes, rowBytes).copy(
      raw, y * (rowBytes + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
