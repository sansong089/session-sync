// antigravity-proto.mjs — Antigravity 会话库的 protobuf 编解码（读写共用）
//
// 取证（2026-11-20，Antigravity 2.33.0 桌面 Hub / CLI 1.x）：steps.step_payload 是一段
// protobuf，外面套一层「step 通用壳」，正文按 step_type 落在不同子消息里：
//
//   step_payload
//     f1  step_type        varint   14=用户 / 15=助手 / 21,132=工具回执
//     f4  status           varint   3=DONE
//     f5  metadata         msg      时间戳、trajectory/cascade id（与 steps.metadata 列同字节）
//     f19 user_payload     msg      f2=正文
//     f20 assistant_payload msg     f1=正文 / f3=thinking / f7=tool_call(id,name,args_json)
//     f21 tool_payload     msg      f4=tool_call（CLI 老形态）
//     f140 render_info     msg      工具输出的可渲染文本
//
// metadata
//     f1  created_at       msg      f1=秒 / f2=100ns ticks（.NET 时钟粒度）
//     f3  kind             varint
//     f4  tool_call        msg      （step_type=132 时；id/name/args_json）
//     f12 user_id          string   36 字节 UUID
//     f20 ids              msg      f1=trajectory_id / f2=cascade_id
//
// trajectory_metadata_blob（每会话一行，id='main'）
//     f1  workspace        msg      f1/f2=file:// URI
//     f2  modified_at      msg      时间戳
//     f3  user_id          string
//     f6  cascade_id       string
//     f7  workspace_uri    string   百分号编码形式
//     f18 project_id       string
//
// 这里只实现「本程序用到的字段」。未知字段一律原样保留在 decode 结果里，但重新编码时
// 会丢弃 —— 所以写侧只用本文件生成新库，不做存量库的原地改写（避免丢宿主私有字段）。
import path from 'node:path';

// ---------------------------------------------------------------------------
// 基础 varint / field 编解码
// ---------------------------------------------------------------------------

export function readVarint(buf, i = 0) {
  let v = 0n;
  let shift = 0n;
  let b;
  do {
    if (i >= buf.length) throw new Error('pb-varint-truncated');
    b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [v, i];
}

export function pbDecode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    try {
      [key, i] = readVarint(buf, i);
    } catch {
      break;
    }
    const f = Number(key >> 3n);
    const w = Number(key & 7n);
    if (!f) break;
    if (w === 0) {
      let v;
      try {
        [v, i] = readVarint(buf, i);
      } catch {
        break;
      }
      out.push({ f, w, v });
    } else if (w === 2) {
      let n;
      try {
        [n, i] = readVarint(buf, i);
      } catch {
        break;
      }
      n = Number(n);
      if (n < 0 || i + n > buf.length) break;
      out.push({ f, w, b: buf.subarray(i, i + n) });
      i += n;
    } else if (w === 5) {
      if (i + 4 > buf.length) break;
      out.push({ f, w, b: buf.subarray(i, i + 4) });
      i += 4;
    } else if (w === 1) {
      if (i + 8 > buf.length) break;
      out.push({ f, w, b: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

export function varintBytes(value) {
  let v = BigInt(value ?? 0);
  if (v < 0n) v += 1n << 64n;
  const out = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

export const pbVar = (f, v) => Buffer.concat([varintBytes((f << 3) | 0), varintBytes(v)]);
export function pbBytes(f, b) {
  const body = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''), 'utf8');
  return Buffer.concat([varintBytes((f << 3) | 2), varintBytes(body.length), body]);
}
export const pbStr = (f, s) => pbBytes(f, String(s ?? ''));
export function pbMsg(f, ...parts) {
  return pbBytes(f, Buffer.concat(parts.filter(Boolean)));
}

export const fieldBuf = (fields, f) => {
  const hit = fields.find((x) => x.f === f && x.b);
  return hit ? Buffer.from(hit.b) : null;
};
export const fieldStr = (fields, f) => {
  const b = fieldBuf(fields, f);
  return b ? b.toString('utf8') : '';
};
export const fieldNum = (fields, f) => {
  const hit = fields.find((x) => x.f === f && x.w === 0);
  return hit ? Number(hit.v) : null;
};
export const allBuf = (fields, f) => fields.filter((x) => x.f === f && x.b).map((x) => Buffer.from(x.b));

// f1=秒 + f2=100ns ticks（实测 Antigravity 用 .NET 时钟粒度，不是纳秒）
export function pbTimeMs(buf) {
  if (!buf) return 0;
  const f = pbDecode(buf);
  const sec = fieldNum(f, 1);
  if (sec == null) return 0;
  const ticks = fieldNum(f, 2) ?? 0;
  return sec * 1000 + Math.floor(ticks / 10000);
}
/** 时间戳**消息体**（不含外层 field tag）：{f1: 秒, f2: 100ns ticks} */
export function pbTimestamp(ms) {
  const t = Number(ms) || Date.now();
  const sec = Math.floor(t / 1000);
  const ticks = (t - sec * 1000) * 10000;
  return Buffer.concat([pbVar(1, sec), pbVar(2, ticks)]);
}

export function toBuf(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'binary');
  if (typeof v === 'object') {
    const keys = Object.keys(v)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
    if (!keys.length) return null;
    const b = Buffer.alloc(keys[keys.length - 1] + 1);
    for (const k of keys) b[k] = Number(v[k]) & 0xff;
    return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 读：step → 内容
// ---------------------------------------------------------------------------

export const STEP_USER = 14;
export const STEP_ASSISTANT = 15;
export const STEP_TOOL = 132;
export const STEP_TOOL_LEGACY = 21;

function decodeToolCall(buf) {
  if (!buf) return null;
  const f = pbDecode(buf);
  const id = fieldStr(f, 1);
  const name = fieldStr(f, 2);
  let args = fieldStr(f, 3);
  if (!args) return null;
  try {
    args = JSON.parse(args);
  } catch {
    /* 保留原样字符串 */
  }
  return { id: id || null, name: name || 'tool', input: args };
}

/** 把一行 steps 解成 {type, ts, role, content, thinking, toolCalls, output}（读侧用） */
export function decodeStepRow(row) {
  const payload = toBuf(row.step_payload ?? row.metadata);
  if (!payload) return null;
  const fs = pbDecode(payload);
  const type = fieldNum(fs, 1) ?? Number(row.step_type) ?? 0;
  const metaBuf = fieldBuf(fs, 5) ?? toBuf(row.metadata);
  const meta = metaBuf ? pbDecode(metaBuf) : [];
  const ts = pbTimeMs(fieldBuf(meta, 1));
  const out = { idx: Number(row.idx) || 0, type, ts, role: null, content: '', thinking: '', toolCalls: [], output: '' };

  const ids = fieldBuf(meta, 20);
  if (ids) {
    const fi = pbDecode(ids);
    out.trajectoryId = fieldStr(fi, 1);
    out.cascadeId = fieldStr(fi, 2);
  }

  if (type === STEP_USER) {
    const u = pbDecode(fieldBuf(fs, 19) ?? Buffer.alloc(0));
    out.role = 'user';
    out.content = fieldStr(u, 2) || fieldStr(u, 3);
  } else if (type === STEP_ASSISTANT) {
    const a = pbDecode(fieldBuf(fs, 20) ?? Buffer.alloc(0));
    out.role = 'assistant';
    out.content = fieldStr(a, 1);
    out.thinking = fieldStr(a, 3);
    for (const b of allBuf(a, 7)) {
      const tc = decodeToolCall(b);
      if (tc) out.toolCalls.push(tc);
    }
  } else if (type === STEP_TOOL || type === STEP_TOOL_LEGACY) {
    const tc = decodeToolCall(fieldBuf(meta, 4) ?? fieldBuf(fs, 21) ?? fieldBuf(fs, 4));
    if (tc) out.toolCalls.push(tc);
    const render = fieldBuf(fs, 140);
    if (render) out.output = render.toString('utf8').replace(/\0/g, '').trim();
  }
  return out;
}

/** trajectory_metadata_blob → 工作区 URI 列表（读侧用） */
export function decodeWorkspaceBlob(buf) {
  const b = toBuf(buf);
  if (!b) return [];
  const fs = pbDecode(b);
  const wmsg = fieldBuf(fs, 1);
  const uris = wmsg ? allBuf(pbDecode(wmsg), 1).map((x) => x.toString('utf8')) : [];
  const extra = fieldStr(fs, 7);
  if (extra && !uris.some((u) => u.includes(extra))) uris.push(extra);
  return uris;
}

/** URI → 本地路径：file:///d%3A/00-lk-agent → d:/00-lk-agent */
export function uriToPath(uri) {
  try {
    const u = new URL(String(uri));
    let p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (/^[a-z]:/i.test(p)) p = p[0].toUpperCase() + p.slice(1);
    return p.replace(/\//g, path.sep === '\\' ? '\\' : '/');
  } catch {
    return '';
  }
}
// ---------------------------------------------------------------------------
// 写：内容 → step
// ---------------------------------------------------------------------------

/**
 * 造一行 step 的 payload / metadata。
 * @param {object} o
 * @param {number} o.type 14 | 15 | 132
 * @param {number} o.ts 毫秒时间戳
 * @param {string} o.trajectoryId
 * @param {string} o.cascadeId
 * @param {string} o.userId
 * @param {string} [o.content]
 * @param {string} [o.thinking]
 * @param {Array<{id,name,input}>} [o.toolCalls]
 * @param {string} [o.toolOutput]
 */
export function encodeStep(o) {
  const ts = Number(o.ts) || Date.now();
  const metaParts = [
    pbMsg(1, pbTimestamp(ts)),
    pbVar(3, o.type === STEP_USER ? 4 : 2),
    pbStr(12, o.userId || 'session-sync-user'),
    pbMsg(20, pbStr(1, o.trajectoryId || ''), pbStr(2, o.cascadeId || '')),
  ];
  if (o.type === STEP_TOOL && o.toolCall) {
    const tc = o.toolCall;
    metaParts.push(pbMsg(4, pbStr(1, tc.id || ''), pbStr(2, tc.name || 'tool'), pbStr(3, JSON.stringify(tc.input ?? null))));
  }
  const metadata = Buffer.concat(metaParts);
  const parts = [pbVar(1, o.type), pbVar(4, 3), pbBytes(5, metadata)];

  if (o.type === STEP_USER) {
    const text = String(o.content ?? '');
    parts.push(pbMsg(19, pbStr(2, text), pbStr(3, text)));
  } else if (o.type === STEP_ASSISTANT) {
    const a = [];
    if (o.content) a.push(pbStr(1, String(o.content)));
    if (o.thinking) a.push(pbStr(3, String(o.thinking)));
    for (const tc of o.toolCalls ?? []) {
      a.push(pbMsg(7, pbStr(1, tc.id || ''), pbStr(2, tc.name || 'tool'), pbStr(3, JSON.stringify(tc.input ?? null))));
    }
    parts.push(pbMsg(20, ...a));
  } else if (o.type === STEP_TOOL) {
    if (o.toolOutput) parts.push(pbStr(140, String(o.toolOutput)));
  }
  return { metadata, step_payload: Buffer.concat(parts) };
}

/** 造 trajectory_metadata_blob 的 'main' 行 */
export function encodeWorkspaceBlob({ uris = [], cascadeId = '', projectId = '', userId = '', ts = Date.now() } = {}) {
  const list = (uris || []).filter(Boolean);
  const primary = list[0] || '';
  const wmsg = pbMsg(1, pbStr(1, primary), pbStr(2, primary));
  const parts = [wmsg, pbMsg(2, pbTimestamp(ts))];
  if (userId) parts.push(pbStr(3, userId));
  if (cascadeId) parts.push(pbStr(6, cascadeId));
  if (primary) parts.push(pbStr(7, primary));
  if (projectId) parts.push(pbStr(18, projectId));
  return Buffer.concat(parts);
}

export function workspaceUriOf(dir) {
  const d = String(dir || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!d) return '';
  if (/^[a-z]:/i.test(d)) return `file:///${d[0].toLowerCase()}%3A/${d.slice(2).replace(/^\/+/, '')}`;
  return `file:///${d}`;
}
