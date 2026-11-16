// Dependency-free image helpers for remote VM screenshots.
// libvirt writes screenshots as binary PPM; agents expect PNG, so the remote
// server converts in-process instead of requiring ImageMagick on the host.
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function pngSize(buffer) {
  if (!isPng(buffer) || buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Encode 8-bit RGB pixels as a PNG image. */
export function pngFromRgb(width, height, rgb) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Invalid image dimensions');
  }
  if (rgb.length !== width * height * 3) throw new Error('Pixel buffer does not match image dimensions');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function headerTokens(text) {
  const tokens = [];
  let index = 0;
  while (tokens.length < 4 && index < text.length) {
    const char = text[index];
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    let token = '';
    while (index < text.length && !/\s/.test(text[index])) token += text[index++];
    tokens.push(token);
  }
  return { tokens, offset: index };
}

/** Decode a binary (P6) or ASCII (P3) PPM screenshot into 8-bit RGB pixels. */
export function decodePpm(buffer) {
  const magic = buffer.subarray(0, 2).toString('ascii');
  if (magic !== 'P6' && magic !== 'P3') throw new Error('Screenshot is not a PPM image');
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  const { tokens, offset } = headerTokens(head);
  if (tokens.length < 4) throw new Error('Incomplete PPM header');
  const [, width, height, maxval] = tokens;
  const widthValue = Number(width);
  const heightValue = Number(height);
  const maxValue = Number(maxval);
  if (!Number.isInteger(widthValue) || !Number.isInteger(heightValue) || widthValue < 1 || heightValue < 1) {
    throw new Error('Invalid PPM dimensions');
  }
  if (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 65535) throw new Error('Invalid PPM maximum value');
  if (widthValue * heightValue > 64 * 1024 * 1024) throw new Error('Screenshot is too large');
  const rgb = Buffer.alloc(widthValue * heightValue * 3);
  if (magic === 'P6') {
    const channels = maxValue > 255 ? 2 : 1;
    // Exactly one whitespace character separates the header from binary data;
    // later whitespace bytes can be genuine pixel values.
    let start = offset;
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    else if (buffer[start] === 0x20 || buffer[start] === 0x0a || buffer[start] === 0x09 || buffer[start] === 0x0d) start += 1;
    const needed = widthValue * heightValue * 3 * channels;
    if (buffer.length - start < needed) throw new Error('Truncated PPM pixel data');
    for (let pixel = 0; pixel < widthValue * heightValue * 3; pixel += 1) {
      const value = channels === 1
        ? buffer[start + pixel]
        : buffer.readUInt16BE(start + pixel * 2);
      rgb[pixel] = channels === 1 ? value : Math.round((value * 255) / maxValue);
    }
  } else {
    const values = buffer.subarray(offset).toString('latin1').trim().split(/\s+/).map(Number);
    if (values.length < widthValue * heightValue * 3) throw new Error('Truncated PPM pixel data');
    for (let pixel = 0; pixel < widthValue * heightValue * 3; pixel += 1) {
      rgb[pixel] = Math.max(0, Math.min(255, Math.round((values[pixel] * 255) / maxValue)));
    }
  }
  return { width: widthValue, height: heightValue, rgb };
}

/** Convert a hypervisor screenshot (PNG passthrough or PPM) into PNG bytes. */
export function toPng(buffer) {
  if (isPng(buffer)) return { png: buffer, ...pngSize(buffer) };
  const { width, height, rgb } = decodePpm(buffer);
  return { png: pngFromRgb(width, height, rgb), width, height };
}
