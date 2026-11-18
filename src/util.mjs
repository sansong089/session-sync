// 通用工具：零依赖（仅 node: 内置模块）
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NODE_ENGINE_MIN = [22, 22];

export function homeDir() {
  return os.homedir();
}

export function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/**
 * 路径比较用的归一化：统一分隔符 + 去尾分隔符 + 大小写不敏感（Windows 的真实语义；
 * posix 上多算一次命中只会多标一次非项目，无害）。
 * 落点分类、注册表分组键、搬迁前后比较都用这一份实现。
 */
export function cmpPath(p) {
  return String(p ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 路径末段（统一分隔符、去尾分隔符）；无路径时返回空串 */
export function baseNameOf(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  return s ? s.split(/[\\/]+/).pop() : '';
}

/**
 * 目录形态归一：**盘符大小写按各宿主自己的约定** + 原生分隔符。
 *
 * 各家宿主都按「自己记的 cwd」现算项目键（slug / md5 / 原串），所以落库形态必须
 * 与该宿主记法一致，否则同一个目录会被当成两个项目（侧栏两个同名分组）。
 *
 * 盘符大小写是**每家自己的约定**（本机真机实测，不能全局一刀切）：
 *   - 大写：claude / pi / minimax / dsh —— 都按 `process.cwd()` 记（Windows 只把盘符变大写）
 *   - 小写：workbuddy —— 记自己的 cwd（小写盘符，本机 46/47 条实测）
 *   - 小写：codebuddy-ide —— 记 URI 形态（`d:/...`，本机 368 条实测）
 *
 * 其余字母的大小写**不动**（宿主记什么就是什么）；分隔符统一成本机原生形态。
 * **不解析 junction / symlink**：宿主记的是逻辑路径（cwd 不解析 junction）。
 *
 * @param {string} input
 * @param {{driveCase?: 'upper'|'lower'|'asis'}} opts
 */
export function canonicalDirPath(input, { driveCase = 'upper' } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  // 盘符开头的写法在 POSIX 上不是绝对路径（path.resolve 会拼上当前目录把它改坏），原样处理
  const winStyle = /^[A-Za-z]:[\\/]/.test(raw);
  if (process.platform !== 'win32') return raw;
  const native = winStyle ? raw.replace(/\//g, '\\') : raw;
  if (driveCase === 'asis') return native;
  const d = driveCase === 'lower' ? 'toLowerCase' : 'toUpperCase';
  return native.replace(/^([a-z]):/i, (_, drive) => `${drive[d]()}:`);
}

// 工具输出 → IR 文本的唯一实现在 text.mjs。这里保留导出名是为了让老调用点
// 与测试不必改 import 路径，但**没有第二份实现**：改规则只改 text.mjs 一处。
export { outputText } from './text.mjs';

export function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// 键序递归排序的稳定序列化：指纹/哈希不随对象键序变化
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// ---- UUID（RFC 4122，零依赖手写） ----

const HEX = '0123456789abcdef';

function formatUuidBytes(bytes) {
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

function parseUuid(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`invalid uuid: ${uuid}`);
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// uuid v5：name + namespace 确定性派生
export function uuid5(name, namespace) {
  const ns = parseUuid(namespace);
  const nameBytes = Buffer.from(String(name), 'utf8');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  return formatUuidBytes(bytes);
}

// uuid v7：时间有序 + 随机
export function uuidv7(now = Date.now()) {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(40 - 8 * i)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuidBytes(bytes);
}

export const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function nodeVersion() {
  return process.versions.node;
}

export function versionAtLeast(current, min) {
  const c = String(current).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    if ((c[i] || 0) > min[i]) return true;
    if ((c[i] || 0) < min[i]) return false;
  }
  return true;
}

export function nowMs() {
  return Date.now();
}

// 解析 "7d" / "2026-10-01" / "2026-10-01T12:00" → ms 时间戳
export function parseTimeSpec(spec, now = Date.now()) {
  if (spec == null || spec === '') return null;
  const s = String(spec).trim();
  let m = /^(\d+)\s*(m|min|minutes?)$/i.exec(s);
  if (m) return now - parseInt(m[1], 10) * 60 * 1000;
  m = /^(\d+)\s*(h|hours?)$/i.exec(s);
  if (m) return now - parseInt(m[1], 10) * 3600 * 1000;
  m = /^(\d+)\s*(d|days?)$/i.exec(s);
  if (m) return now - parseInt(m[1], 10) * 24 * 3600 * 1000;
  m = /^(\d+)\s*(w|weeks?)$/i.exec(s);
  if (m) return now - parseInt(m[1], 10) * 7 * 24 * 3600 * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`无法解析时间参数: ${spec}`);
  return t;
}

/**
 * --until 专用：纯日期按「到这一天为止」理解（含当天 23:59:59.999，UTC，与 since 的 00:00 同基准）。
 * 其余写法与 parseTimeSpec 相同（7d / ISO 时刻）。
 */
export function parseUntilSpec(spec, now = Date.now()) {
  if (spec == null || spec === '') return null;
  const s = String(spec).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`无法解析时间参数: ${spec}`);
    return t + 24 * 3600 * 1000 - 1;
  }
  return parseTimeSpec(s, now);
}

/**
 * 原子整文件替换：同目录写临时文件 → fsync → rename 覆盖。
 * 好处：宿主/其它进程任何时刻读到的都是「完整的旧版本」或「完整的新版本」，不会看到半个文件。
 * Node 在 Windows 上 rename 也带 MOVEFILE_REPLACE_EXISTING，可直接覆盖。
 *
 * expectSize / expectMtimeMs（可选）：写前校验目标仍是调用方读到的那一版。
 * 只做整份覆盖的调用方（标题改写 = 读整份→改一行→覆盖回去）必须传，否则会把
 * 宿主在这期间追加的轮次一起抹掉。写完 tmp 再比对而不是写前比对：比对失败时
 * 磁盘上还是宿主那份新内容，我们只是丢弃 tmp。
 *
 * 诚实边界：stat 与 rename 之间仍有毫秒级 TOCTOU；mtime 也只有毫秒精度，
 * 同一毫秒内的原地重写看不出来。这是「锁 + 写前校验 + 重试」的三层收敛，
 * 不是严格 CAS —— Windows 上无法对已被宿主打开的文件做排他 rename。
 */
export function writeFileAtomic(file, content, opts = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* 某些文件系统不支持 */
    }
  } finally {
    fs.closeSync(fd);
  }
  if (opts.expectSize != null || opts.expectMtimeMs != null) {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      /* 目标不存在：按 -1 参与比对（「我以为有」而实际没了也算并发改动） */
    }
    const sizeOk = opts.expectSize == null || (st ? st.size : -1) === opts.expectSize;
    const mtimeOk = opts.expectMtimeMs == null || (st ? st.mtimeMs : -1) === opts.expectMtimeMs;
    if (!sizeOk || !mtimeOk) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      const err = new Error(
        `concurrent-modification: ${file} (size ${st ? st.size : -1}/${opts.expectSize}, mtime ${st ? st.mtimeMs : -1}/${opts.expectMtimeMs})`,
      );
      err.code = 'CONCURRENT_MODIFICATION';
      throw err;
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  return file;
}
