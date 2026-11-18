// readers/doubao.mjs — 豆包（Doubao）agent 模式
//
// 存储：<userData>/<Profile>/.doubao/agent_mode/workspace/.sessions/<chatId>/
//   agents/<agentId>/system/assignment.md    append-only：头 4 行 + `## [ISO] 需求` 块
//   agents/<agentId>/system/trajectory.jsonl 逐行 {role, content, tool_calls?, tool_call_id?}
//   board.md                                 任务公告板（尾部 `_最后更新：…Z_`）
// 会话 id = chatId；多 agent 目录（m_ / o_ / s_）归一为一条会话，main 作主线。
// 只读：侧栏 = 云端 + IndexedDB 缓存，`.sessions` 不是会话注册表（agent-storage §22 V7）。
import fs from 'node:fs';
import path from 'node:path';
import { candidateRoots } from '../roots.mjs';
import { makeSession, messageItem, toolCallItem, toolResultItem, finalizeSession } from '../ir.mjs';
import { parseJsonl, fileMtime, inTimeRange, stripSystemInjections, assembleTurns } from './base.mjs';
import { previewTitle } from '../titles.mjs';

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

// assignment.md：头 4 行 + 每个 `## [ISO8601] 需求` 块（append-only）。
// 块里可能整段是宿主注入（system-reminder），剥完为空的不算一轮。
function parseAssignment(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = /^## \[([^\]]+)\] 需求\s*$/.exec(line.trim());
    if (m) {
      cur = { ts: Date.parse(m[1]) || 0, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return blocks
    .map((b) => ({ ts: b.ts, text: stripSystemInjections(b.lines.join('\n')).trim() }))
    .filter((b) => b.text);
}

// board.md 的 `_最后更新：2026-…Z_`（纳秒精度，Date.parse 会截断到毫秒）
function boardUpdatedAt(sessionDir) {
  const m = /_最后更新：([^_\n]+)_/.exec(safeRead(path.join(sessionDir, 'board.md')));
  return m ? Date.parse(m[1].trim()) || 0 : 0;
}

// 落点只走 roots.mjs 的唯一入口：`--data-root` 钉过、env 搬过、探测命中的根都要照样读得到
// （直接调 hosts 里的声明函数会漏掉搬过位置的根）。
// userData / profile 从会话目录路径本身反推（<userData>/<profile>/.doubao/agent_mode/workspace/.sessions），
// 钉住与探测两种形状共用同一条推导，不必再声明一遍。
function sessionRoots(ctx) {
  return candidateRoots('doubao', ctx)
    .filter((c) => c.role === 'sessions')
    .map((c) => {
      const segs = path.normalize(c.path).split(/[\\/]+/);
      const i = segs.lastIndexOf('.doubao');
      return { path: c.path, profile: i > 0 ? segs[i - 1] : null, userData: i > 1 ? segs.slice(0, i - 1).join(path.sep) : null };
    });
}

// 工作区映射：Preferences 的 `saman.local_storage_for_web.home` 是**字符串化**的 KV JSON。
// 部分会话没有映射（产物目录懒创建），取不到就留空。
function workspaceMap(userData, profile) {
  const out = new Map();
  if (!userData || !profile) return out;
  try {
    const pref = JSON.parse(safeRead(path.join(userData, profile, 'Preferences')));
    const holder = pref?.saman?.local_storage_for_web?.home;
    if (typeof holder !== 'string' || !holder.trim()) return out;
    for (const [k, v] of Object.entries(JSON.parse(holder) ?? {})) {
      const m = /^general-agent:new-chat-workspace:(.+)$/.exec(k);
      if (m && typeof v === 'string' && v.trim()) out.set(m[1], v.trim());
    }
  } catch {
    /* Preferences 不可读 = 没有映射，不猜 */
  }
  return out;
}

function readAgent(sessionDir, agentId) {
  const system = path.join(sessionDir, 'agents', agentId, 'system');
  const assignment = safeRead(path.join(system, 'assignment.md'));
  const head = assignment.split('\n').slice(0, 6).join('\n');
  return {
    agentId,
    role: (/- Role:\s*(\w+)/.exec(head)?.[1] ?? '').toLowerCase(),
    assignedBy: (/- Assigned by:\s*(.+)/.exec(head)?.[1] ?? '').trim(),
    blocks: parseAssignment(assignment),
    trajectory: parseJsonl(safeRead(path.join(system, 'trajectory.jsonl'))),
    trajectoryFile: path.join(system, 'trajectory.jsonl'),
  };
}

// 一条会话 = 一个 .sessions/<chatId> 目录；main 作主线，其余 agent 只进名册。
// 没有 main 轨迹的目录跳过（空 agent 壳不构成可导入会话）。
function indexSession(sessionDir) {
  let agentDirs = [];
  try {
    agentDirs = fs
      .readdirSync(path.join(sessionDir, 'agents'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  const agents = agentDirs.map((a) => readAgent(sessionDir, a));
  const main = agents.find((a) => a.role === 'main') ?? agents.find((a) => a.agentId.startsWith('m_')) ?? agents[0];
  if (!main || main.trajectory.length === 0) return null;
  // 空 agent 壳（无 assignment 也无 trajectory）不进名册
  return { main, others: agents.filter((a) => a !== main && (a.trajectory.length > 0 || a.blocks.length > 0)) };
}

// trajectory 行 + assignment 需求块 → 扁平条目流（list 的轮次与 read 共用这一份）
function buildEntries(main) {
  const entries = [];
  const blocks = main.blocks.slice();
  const used = new Set();
  const takeTs = (text) => {
    const t = norm(text);
    const idx = blocks.findIndex((b, i) => !used.has(i) && norm(b.text) === t);
    if (idx < 0) return 0;
    used.add(idx);
    return blocks[idx].ts;
  };

  // 首轮用户消息只在 assignment（不进 trajectory）：未被 trajectory 覆盖的块按块头时间补在最前。
  // 块时间单调递增，观测量里只有首块会命中这条路径。
  const userTexts = new Set(main.trajectory.filter((r) => r?.role === 'user').map((r) => norm(stripSystemInjections(r.content))));
  blocks.forEach((b, i) => {
    if (userTexts.has(norm(b.text))) return;
    used.add(i);
    entries.push({ role: 'user', ts: b.ts, items: [messageItem('user', b.text, b.ts)] });
  });

  let lastUserTs = entries.length ? entries[entries.length - 1].ts : 0;
  const callNames = new Map();
  for (const row of main.trajectory) {
    const role = String(row?.role ?? '');
    const text = String(row?.content ?? '');
    if (role === 'user') {
      lastUserTs = takeTs(text) || lastUserTs;
      const clean = stripSystemInjections(text).trim();
      if (clean) entries.push({ role: 'user', ts: lastUserTs, items: [messageItem('user', clean, lastUserTs)] });
      continue;
    }
    if (role === 'assistant') {
      const items = [];
      if (text.trim()) items.push(messageItem('assistant', text, lastUserTs));
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const id = call?.id ?? null;
        const name = call?.function?.name ?? 'tool';
        if (id) callNames.set(id, name);
        // arguments 已经是 JSON 对象（不是 OpenAI 的字符串），原样带进 IR，不再二次序列化
        items.push(toolCallItem(id, name, call?.function?.arguments ?? null, lastUserTs));
      }
      if (items.length) entries.push({ role: 'assistant', ts: lastUserTs, items });
      continue;
    }
    if (role === 'tool') {
      const id = row.tool_call_id ?? null;
      const status = /^\s*Error:/.test(text) || /exited with code [1-9]\d*/.test(text) ? 'error' : 'ok';
      entries.push({ role: 'assistant', ts: lastUserTs, items: [toolResultItem(id, callNames.get(id) ?? 'tool', status, text, lastUserTs)] });
    }
  }
  return entries;
}

function parseSession(sessionDir, root) {
  const info = indexSession(sessionDir);
  if (!info) return null;
  const turns = assembleTurns(buildEntries(info.main));
  const firstBlock = info.main.blocks[0]?.text ?? '';
  const chatId = path.basename(sessionDir);
  const blockTs = info.main.blocks.map((b) => b.ts).filter(Boolean);
  return {
    id: chatId,
    variant: 'doubao',
    title: previewTitle(firstBlock) || 'untitled',
    preview: String(firstBlock).replace(/\s+/g, ' ').slice(0, 120),
    cwd: workspaceMap(root.userData, root.profile).get(chatId) ?? '',
    createdAt: blockTs.length ? Math.min(...blockTs) : fileMtime(info.main.trajectoryFile),
    updatedAt: Math.max(fileMtime(info.main.trajectoryFile), boardUpdatedAt(sessionDir), ...blockTs),
    turns,
    info,
    root,
    sessionDir,
  };
}

function findSession(ctx, id) {
  for (const root of sessionRoots(ctx)) {
    const dir = path.join(root.path, String(id));
    if (fs.existsSync(path.join(dir, 'agents'))) return { dir, root };
  }
  return null;
}

export const doubaoReader = {
  variant: 'doubao',
  label: '豆包 (Doubao) agent 模式',

  available(ctx) {
    return sessionRoots(ctx).some((r) => fs.existsSync(r.path));
  },

  list(ctx, opts = {}) {
    const out = [];
    for (const root of sessionRoots(ctx)) {
      let names = [];
      try {
        names = fs.readdirSync(root.path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        continue;
      }
      for (const name of names) {
        const s = parseSession(path.join(root.path, name), root);
        if (!s) continue;
        out.push({
          id: s.id,
          variant: 'doubao',
          title: s.title,
          preview: s.preview,
          cwd: s.cwd,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          turns: s.turns.length,
          turnsApprox: false,
          model: null,
          project: null,
          // agent 模式会话是云端聊天，本地目录只是工作区：显式非项目，不靠目录猜
          scope: 'none',
          source: 'sessions',
          provenance: null,
          sourcePath: s.sessionDir,
        });
      }
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const hit = findSession(ctx, id);
    if (!hit) return null;
    const s = parseSession(hit.dir, hit.root);
    if (!s) return null;
    const session = makeSession({
      id: String(id),
      variant: 'doubao',
      title: s.title,
      cwd: s.cwd,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      model: null,
      scope: 'none',
      turns: s.turns,
      meta: {
        sourcePath: hit.dir,
        chatId: String(id),
        profile: hit.root.profile,
        agents: [s.info.main, ...s.info.others].map((a) => ({ id: a.agentId, role: a.role, assignedBy: a.assignedBy })),
      },
    });
    return finalizeSession(session);
  },
};
