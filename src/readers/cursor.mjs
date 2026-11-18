// readers/cursor.mjs — Cursor
// 旧版（本机实证可用）：%APPDATA%\Cursor\User\globalStorage\state.vscdb 的 cursorDiskKV 表，
//   key = composerData:<uuid>，value = 整会话 JSON（composerId/name/conversation[]/forceMode/createdAt）
//   workspace 索引：workspaceStorage/<hash>/state.vscdb 的 composer.composerData + workspace.json(folder URI)
// 新版：~/.cursor/chats/<hash>/<id>/store.db（meta/blobs 两表）——best-effort 读取，schema 未文档化
import path from 'node:path';
import fs from 'node:fs';
import { makeSession, messageItem, metaItem, attachmentItem, finalizeSession } from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR } from '../provenance.mjs';
import { openDb, safeJson, tableExists, tableColumns, tableHasColumn, inTimeRange, assembleTurns, deriveTitle, stripSystemInjections } from './base.mjs';

import { isDir, isFile } from '../util.mjs';
import { candidateRoots, roleRoots } from '../roots.mjs';

function paths(ctx) {
  // 按 role 分辨三种语义，不再靠路径后缀（搬目录/改名后后缀匹配会失效）
  const read = candidateRoots('cursor', ctx);
  const globalDb = read.find((x) => x.role === 'db')?.path ?? null;
  const wsDir = read.find((x) => x.role === 'cwdMap')?.path ?? null;
  const chatsDir = read.find((x) => x.role === 'sessions')?.path ?? null;
  return { globalDb, wsDir, chatsDir };
}

function decodeFolderUri(uri) {
  if (!uri) return '';
  try {
    let p = String(uri).replace(/^file:\/\//, '');
    p = decodeURIComponent(p);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p.replace(/\//g, path.sep);
  } catch {
    return String(uri);
  }
}

// workspace hash → cwd 映射
function workspaceMap(wsDir) {
  const map = new Map();
  if (!wsDir || !isDir(wsDir)) return map;
  for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(wsDir, entry.name);
    let folder = '';
    try {
      const wj = safeJson(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'), null);
      folder = decodeFolderUri(wj?.folder ?? wj?.workspace ?? '');
    } catch {
      /* ignore */
    }
    const dbFile = path.join(dir, 'state.vscdb');
    if (!isFile(dbFile)) continue;
    try {
      const db = openDb(dbFile);
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      db.close();
      const obj = safeJson(row?.value?.toString?.('utf8') ?? row?.value ?? '', null);
      for (const c of obj?.allComposers ?? []) {
        if (c?.composerId) map.set(c.composerId, { cwd: folder, workspaceHash: entry.name });
      }
    } catch {
      /* ignore */
    }
  }
  return map;
}

// Lexical richText JSON → 纯文本
function richTextToPlain(rich) {
  if (!rich) return '';
  let obj = rich;
  if (typeof rich === 'string') obj = safeJson(rich, null);
  if (!obj) return '';
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') out.push(node.text);
    for (const child of node.children ?? []) walk(child);
    if (node.root) walk(node.root);
  };
  walk(obj);
  return out.join('');
}

function bubbleItems(bubble) {
  const ts = Number(bubble?.timingInfo?.clientStartTime) || 0;
  const items = [];
  const isUser = bubble?.type === 1;
  const raw = String(bubble?.text ?? '').trim() || richTextToPlain(bubble?.richText).trim();
  const text = isUser ? stripSystemInjections(raw) : raw;
  if (text) items.push(messageItem(isUser ? 'user' : 'assistant', text, ts));
  for (const cb of bubble?.codeBlocks ?? []) {
    items.push(metaItem('codeBlock', cb?.uri ?? '', ts));
  }
  for (const rf of bubble?.relevantFiles ?? []) {
    items.push(attachmentItem(rf, 'relevant file', ts));
  }
  return items;
}

function parseComposer(id, raw) {
  const obj = typeof raw === 'string' ? safeJson(raw, null) : safeJson(raw?.toString?.('utf8') ?? '', null);
  if (!obj) return null;
  const prov = provenanceFromObject(obj['session-sync']) || null;
  const entries = [];
  for (const b of obj.conversation ?? []) {
    const role = b?.type === 1 ? 'user' : 'assistant';
    entries.push({ role, ts: Number(b?.timingInfo?.clientStartTime) || 0, items: bubbleItems(b) });
  }
  const turns = assembleTurns(entries);
  const session = makeSession({
    id,
    variant: 'cursor',
    title: deriveTitle(obj.name, turns),
    cwd: '',
    createdAt: Number(obj.createdAt) || 0,
    updatedAt: Number(obj.lastUpdatedAt) || Number(obj.createdAt) || 0,
    model: null,
    turns,
    meta: { forceMode: obj.forceMode ?? null, status: obj.status ?? null, generation: 'state.vscdb' },
  });
  applyProvenanceToIR(session, prov);
  return finalizeSession(session);
}

// 新代 store.db：best-effort（meta/blobs 两表，blob 可能是 JSON）
function readNewGenChat(storeFile) {
  try {
    const db = openDb(storeFile);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      const blobTable = tables.find((t) => /blob/i.test(t));
      if (!blobTable) return null;
      const cols = tableColumns(db, blobTable);
      const dataCol = cols.find((c) => /data|value|body/i.test(c)) ?? cols[cols.length - 1];
      const rows = db.prepare(`SELECT ${JSON.stringify(dataCol)} AS v FROM ${JSON.stringify(blobTable)}`).all();
      for (const r of rows) {
        const text = typeof r.v === 'string' ? r.v : r.v?.toString?.('utf8') ?? '';
        const obj = safeJson(text, null);
        if (obj && (Array.isArray(obj.conversation) || Array.isArray(obj.messages) || Array.isArray(obj.bubbles))) {
          const conv = obj.conversation ?? obj.messages ?? obj.bubbles;
          const entries = conv.map((b) => ({
            role: b?.type === 1 || b?.role === 'user' ? 'user' : 'assistant',
            ts: Number(b?.timingInfo?.clientStartTime) || 0,
            items: bubbleItems(b),
          }));
          const turns = assembleTurns(entries);
          const id = path.basename(path.dirname(storeFile));
          const session = makeSession({
            id,
            variant: 'cursor',
            title: deriveTitle(obj.name, turns),
            createdAt: Number(obj.createdAt) || 0,
            turns,
            meta: { generation: 'store.db', sourcePath: storeFile },
          });
          applyProvenanceToIR(session, provenanceFromObject(obj['session-sync']) || null);
          return finalizeSession(session);
        }
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function newGenChatDirs(chatsDir) {
  const out = [];
  if (!chatsDir || !isDir(chatsDir)) return out;
  for (const hash of fs.readdirSync(chatsDir, { withFileTypes: true })) {
    if (!hash.isDirectory()) continue;
    const hd = path.join(chatsDir, hash.name);
    for (const id of fs.readdirSync(hd, { withFileTypes: true })) {
      if (!id.isDirectory()) continue;
      const store = path.join(hd, id.name, 'store.db');
      if (isFile(store)) out.push(store);
    }
  }
  return out;
}

export const cursorReader = {
  variant: 'cursor',
  label: 'Cursor',

  available(ctx) {
    const p = paths(ctx);
    return (!!p.globalDb && isFile(p.globalDb)) || newGenChatDirs(p.chatsDir).length > 0;
  },

  list(ctx, opts = {}) {
    const p = paths(ctx);
    const out = [];
    if (p.globalDb && isFile(p.globalDb)) {
      const wsMap = workspaceMap(p.wsDir);
      const db = openDb(p.globalDb);
      try {
        if (tableExists(db, 'cursorDiskKV')) {
          const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
          for (const r of rows) {
            const id = r.key.slice('composerData:'.length);
            const obj = safeJson(r.value?.toString?.('utf8') ?? r.value ?? '', null);
            if (!obj) continue;
            const conv = obj.conversation ?? [];
            const ws = wsMap.get(id);
            out.push({
              id,
              variant: 'cursor',
              title: obj.name || '',
              cwd: ws?.cwd ?? '',
              createdAt: Number(obj.createdAt) || 0,
              updatedAt: Number(obj.lastUpdatedAt) || Number(obj.createdAt) || 0,
              turns: conv.filter((b) => b?.type === 1).length,
              provenance: provenanceFromObject(obj['session-sync']) || null,
              sourcePath: p.globalDb,
            });
          }
        }
      } finally {
        db.close();
      }
    }
    for (const store of newGenChatDirs(p.chatsDir)) {
      const s = readNewGenChat(store);
      if (s) {
        out.push({
          id: s.id,
          variant: 'cursor',
          title: s.title,
          cwd: s.cwd,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          turns: s.turns.filter((t) => t.role === 'user').length,
          provenance: s.origin ? { origin: s.origin, chain: s.chain } : null,
          sourcePath: store,
        });
      }
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const p = paths(ctx);
    if (p.globalDb && isFile(p.globalDb)) {
      const db = openDb(p.globalDb);
      try {
        if (tableExists(db, 'cursorDiskKV')) {
          const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`);
          if (row) {
            const session = parseComposer(id, row.value);
            if (session) {
              const ws = workspaceMap(p.wsDir).get(id);
              if (ws?.cwd) session.cwd = ws.cwd;
              return session;
            }
          }
        }
      } finally {
        db.close();
      }
    }
    for (const store of newGenChatDirs(p.chatsDir)) {
      if (path.basename(path.dirname(store)) === id) {
        const s = readNewGenChat(store);
        if (s) return s;
      }
    }
    return null;
  },
};
