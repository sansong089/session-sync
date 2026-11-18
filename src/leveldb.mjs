// leveldb.mjs — 只读 LevelDB（Chromium Local Storage）最小实现
//
// 用途：MiniMax Code 的「项目改名」只写 renderer localStorage（LevelDB），宿主没有任何明文镜像，
// 要按宿主协议显示项目名就只能把这份存储读出来。
// 只实现读路径，且只做 Local Storage 需要的部分：
//   .ldb（SSTable：footer → index block → data block，支持 Snappy 压缩块）
//   .log（WAL：32KB 物理块 + FULL/FIRST/MIDDLE/LAST 逻辑记录 → WriteBatch）
// 不校验 CRC（只读、不写）；解析失败一律当作「没有」，绝不抛给调用方。
//
// 条目版本：内部键尾部 8 字节 = (seq << 8 | type)；同键取最大 seq，type 0 = 删除。
import fs from 'node:fs';
import path from 'node:path';

function varint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function snappyDecompress(input) {
  let pos = 0;
  const [uncompressed, p] = varint(input, 0);
  pos = p;
  const out = Buffer.alloc(uncompressed);
  let o = 0;
  while (pos < input.length) {
    const tag = input[pos++];
    const type = tag & 3;
    if (type === 0) {
      let len = tag >> 2;
      if (len < 60) {
        len += 1;
      } else {
        const n = len - 59;
        len = 0;
        for (let i = 0; i < n; i++) len += input[pos++] * 2 ** (8 * i);
        len += 1;
      }
      input.copy(out, o, pos, pos + len);
      o += len;
      pos += len;
    } else {
      let len;
      let off;
      if (type === 1) {
        len = ((tag >> 2) & 7) + 4;
        off = ((tag & 0xe0) << 3) | input[pos++];
      } else if (type === 2) {
        len = (tag >> 2) + 1;
        off = input[pos] | (input[pos + 1] << 8);
        pos += 2;
      } else {
        len = (tag >> 2) + 1;
        off = input.readUInt32LE(pos);
        pos += 4;
      }
      for (let i = 0; i < len; i++) {
        out[o] = out[o - off];
        o++;
      }
    }
  }
  return out;
}

function readBlock(fd, handle) {
  const buf = Buffer.alloc(handle.size + 5);
  const n = fs.readSync(fd, buf, 0, handle.size + 5, handle.offset);
  if (n < handle.size + 5) throw new Error('short block');
  const type = buf[handle.size];
  const data = buf.subarray(0, handle.size);
  if (type === 0) return data;
  if (type === 1) return snappyDecompress(data);
  throw new Error(`unsupported block compression ${type}`);
}

function blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  let pos = 0;
  let key = Buffer.alloc(0);
  const out = [];
  while (pos < end) {
    let shared;
    let nonShared;
    let valueLen;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);
    const delta = block.subarray(pos, pos + nonShared);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    key = Buffer.concat([key.subarray(0, shared), delta]);
    out.push({ key, value });
  }
  return out;
}

function readSst(file) {
  const size = fs.statSync(file).size;
  if (size < 48) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const footer = Buffer.alloc(48);
    fs.readSync(fd, footer, 0, 48, size - 48);
    let pos = 0;
    let metaOffset;
    let metaSize;
    let indexOffset;
    let indexSize;
    [metaOffset, pos] = varint(footer, pos);
    [metaSize, pos] = varint(footer, pos);
    [indexOffset, pos] = varint(footer, pos);
    [indexSize, pos] = varint(footer, pos);
    const out = [];
    for (const entry of blockEntries(readBlock(fd, { offset: indexOffset, size: indexSize }))) {
      let p = 0;
      let offset;
      let blockSize;
      [offset, p] = varint(entry.value, p);
      [blockSize, p] = varint(entry.value, p);
      for (const item of blockEntries(readBlock(fd, { offset, size: blockSize }))) out.push(item);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

const LOG_BLOCK = 32 * 1024;

function readLog(file) {
  const buf = fs.readFileSync(file);
  const records = [];
  let pos = 0;
  let pending = null;
  while (pos + 7 <= buf.length) {
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const data = buf.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) {
      records.push(data);
      pending = null;
    } else if (type === 2) {
      pending = data;
    } else if (type === 3 && pending) {
      pending = Buffer.concat([pending, data]);
    } else if (type === 4 && pending) {
      records.push(Buffer.concat([pending, data]));
      pending = null;
    } else if (type === 0) {
      // 块尾 padding：跳到下一个物理块边界
      pos = Math.ceil(pos / LOG_BLOCK) * LOG_BLOCK;
    }
  }

  const out = [];
  for (const rec of records) {
    if (rec.length < 12) continue;
    const count = rec.readUInt32LE(8);
    let p = 12;
    const batch = [];
    let ok = true;
    for (let i = 0; i < count && ok; i++) {
      if (p >= rec.length) {
        ok = false;
        break;
      }
      const tag = rec[p++];
      let keyLen;
      [keyLen, p] = varint(rec, p);
      if (p + keyLen > rec.length) {
        ok = false;
        break;
      }
      const key = rec.subarray(p, p + keyLen);
      p += keyLen;
      if (tag === 1) {
        let valueLen;
        [valueLen, p] = varint(rec, p);
        if (p + valueLen > rec.length) {
          ok = false;
          break;
        }
        batch.push({ key, value: rec.subarray(p, p + valueLen) });
        p += valueLen;
      } else if (tag === 0) {
        batch.push({ key, value: null });
      } else {
        ok = false;
      }
    }
    // 批内条数与实际解析条数不符 = 记录边界错位，整批丢弃（宁可少读也不读错）
    if (!ok || p !== rec.length) continue;
    out.push(...batch);
  }
  return out;
}

function decodeEntry(rawKey, value) {
  if (rawKey.length < 9) return null;
  const user = rawKey.subarray(0, rawKey.length - 8);
  const trailer = rawKey.readBigUInt64LE(rawKey.length - 8);
  const type = Number(trailer & 0xffn);
  const seq = Number(trailer >> 8n);
  if (type !== 0 && type !== 1) return null;
  return { user, seq, value: type === 0 ? null : value };
}

/** 读取一个 LevelDB 目录的当前视图：userKey(latin1) → {seq, value|null} */
export function readLevelDb(dir) {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return map;
  }
  const apply = (entries, inclusive) => {
    for (const e of entries) {
      const d = decodeEntry(e.key, e.value);
      if (!d) continue;
      const key = d.user.toString('latin1');
      const prev = map.get(key);
      if (!prev || d.seq > prev.seq || (inclusive && d.seq === prev.seq)) map.set(key, { seq: d.seq, value: d.value });
    }
  };
  for (const f of files.filter((n) => n.endsWith('.ldb')).sort()) {
    try {
      apply(readSst(path.join(dir, f)), false);
    } catch {
      /* 单个表损坏不影响其它文件 */
    }
  }
  for (const f of files.filter((n) => n.endsWith('.log')).sort()) {
    try {
      apply(readLog(path.join(dir, f)), true);
    } catch {
      /* WAL 损坏同上 */
    }
  }
  return map;
}

/**
 * Chromium Local Storage 的键值解码：
 *   键 = "_" + origin + "\0" + (utf16 ? "\x01" : "\0") + 真正的 key
 *   值 = (utf16 ? "\0" : "\x01") + 字节（UTF-16LE / UTF-8）
 * 前缀字节不同 Chromium 版本有差异，所以按内容再兜底试另一种编码。
 */
export function decodeLocalStorageEntry(userKey, value) {
  const zero = userKey.indexOf(0);
  if (zero < 0 || zero + 2 > userKey.length) return null;
  const key = userKey.subarray(zero + 2);
  if (!key.length) return null;
  if (value == null) return { key: key.toString('utf8'), value: null };
  const body = value.subarray(1);
  let text = null;
  if (value[0] === 0) text = body.toString('utf16le');
  else text = body.toString('utf8');
  if (text.includes('\uFFFD')) {
    const alt = value[0] === 0 ? body.toString('utf8') : body.toString('utf16le');
    if (!alt.includes('\uFFFD')) text = alt;
  }
  return { key: key.toString('utf8'), value: text };
}

/** 读取目录下全部 Local Storage 键值（删除项已剔除） */
export function readLocalStorage(dir) {
  const out = new Map();
  for (const [rawKey, entry] of readLevelDb(dir)) {
    if (entry.value == null) continue;
    const decoded = decodeLocalStorageEntry(Buffer.from(rawKey, 'latin1'), entry.value);
    if (decoded) out.set(decoded.key, decoded.value);
  }
  return out;
}
