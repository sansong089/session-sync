// 真机取证（可复跑）：豆包本地写 `.sessions` 宿主到底认不认 —— 决定 doubao 可写性的那一次实验
//
// 不是单元测试（文件名不匹配 test/*.test.mjs，`npm test` 不会跑它）；手动执行：
//   node test/real-host/doubao-q3.mjs status     # 只读：看基线与探针在不在
//   node test/real-host/doubao-q3.mjs plant      # 种一枚原生形状的探针会话（已存在则拒绝）
//   node test/real-host/doubao-q3.mjs scan       # 只读：跑文件型两处 oracle（IDB 列表缓存 + 宿主日志）
//   node test/real-host/doubao-q3.mjs rollback   # 逐文件核对后删除探针
//
// 三处 oracle（全阴性才算「宿主不认本地写入」）：
//   1) GUI 侧栏「对话」+「工作」两个视图 —— 本脚本做不了，要开豆包人工看；
//      同一天必须有原生会话排在列表里，否则「探针不在列」不能证明任何东西（列表可能压根没加载）。
//   2) IDB 会话列表缓存：探针的 chatId（latin1）与标题（UTF-16LE + latin1）在各 value 里是否出现；
//      标题里的通用词会撞 base64 巧合子串，所以只扫 chatId + 完整标题，并打印命中上下文。
//   3) 宿主启动日志：`sdk_storage/log/` 与 `<profile>/agent_infra/` 里是否扫到过探针目录。
// 结论登记在 agent-storage.md §22 V7 与写入检查单：阴性 → `write: false`（与 antigravity / cursor 同档）。
import fs from 'node:fs';
import path from 'node:path';
import { makeCtx, doubaoSessionRoots } from '../../src/hosts.mjs';
import { readLevelDb } from '../../src/leveldb.mjs';

const CHAT = '38459900000000001';
const AGENT = 'm_0ssQ3Probe1';
const TITLE = 'session-sync Q3 探针：本地写入可见性验证';
const mode = process.argv[2] || 'status';
const ctx = makeCtx({ env: process.env });
const roots = doubaoSessionRoots(ctx);
const root = roots.find((r) => fs.existsSync(r.path)) ?? roots[0];
const dir = path.join(root.path, CHAT);
const now = () => new Date().toISOString().replace('Z', '000000Z'); // 纳秒形态与宿主一致

// plant 与 rollback 共用同一份清单：两边逐文件相等 = 宿主没往探针里写过任何东西
const FILES = [
  `agents/${AGENT}/system/assignment.md`,
  `agents/${AGENT}/system/trajectory.jsonl`,
  `agents/${AGENT}/socket/briefing.md`,
  `agents/${AGENT}/socket/findings.jsonl`,
  'board.md',
  'memory/MEMORY.md',
];
const DIRS = FILES.map((f) => path.dirname(f)).filter((d, i, a) => a.indexOf(d) === i);

const listing = () => (fs.existsSync(root.path) ? fs.readdirSync(root.path).sort() : []);
const walk = (d, rel = '', out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, `${rel}${e.name}/`, out);
    else out.push(`${rel}${e.name}`.replaceAll('\\', '/'));
  }
  return out.sort();
};

const grepFiles = (file, needles) => {
  const hits = [];
  let names = [];
  try {
    names = fs.readdirSync(file, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(file, e.name));
  } catch {
    return null; // 目录不存在：如实报缺，不当成 0 命中
  }
  for (const f of names) {
    const buf = fs.readFileSync(f);
    for (const n of needles) {
      const needle = Buffer.from(n, 'utf8');
      let i = buf.indexOf(needle);
      while (i >= 0) {
        hits.push(`${path.basename(f)}: …${buf.subarray(Math.max(0, i - 40), i + 40).toString('latin1').replace(/[^\x20-\x7e]/g, ' ')}…`);
        i = buf.indexOf(needle, i + 1);
      }
    }
  }
  return { count: hits.length, sample: hits.slice(0, 5) };
};

if (mode === 'plant') {
  if (fs.existsSync(dir)) throw new Error('探针目录已存在 —— 拒绝覆盖');
  for (const d of [...DIRS, `agents/${AGENT}/system/tool-results`, `agents/${AGENT}/system/poll-monitors`, 'attachments', `agents/${AGENT}/scratch`]) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  const ts = now();
  const sys = path.join(dir, `agents/${AGENT}/system`);
  fs.writeFileSync(
    path.join(sys, 'assignment.md'),
    `# Assignment\n- Agent ID: ${AGENT}\n- Role: main\n- Assigned by: user\n- Created: ${ts}\n\n> append-only: 每个 turn 的需求按时间戳追加在下方，最新在末尾。\n\n## [${ts}] 需求\n${TITLE}\n`,
  );
  fs.writeFileSync(
    path.join(sys, 'trajectory.jsonl'),
    `${JSON.stringify({ role: 'assistant', content: '这是 session-sync 的 Q3 探针会话：验证本地写入 .sessions 后宿主侧栏是否列出。看到这条消息说明本地文件被宿主读取了。' })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'board.md'),
    `# 任务公告板（board.md）· session ${CHAT}\n\n_最后更新：${ts}_\n\n| 任务ID | 标题 | Organizer | 状态 | 产物路径 | 产物链接 |\n| --- | --- | --- | --- | --- | --- |\n`,
  );
  fs.writeFileSync(path.join(dir, 'memory/MEMORY.md'), '');
  fs.writeFileSync(path.join(dir, `agents/${AGENT}/socket/briefing.md`), '');
  fs.writeFileSync(path.join(dir, `agents/${AGENT}/socket/findings.jsonl`), '');
  console.log(JSON.stringify({ ok: true, root: root.path, baseline: listing(), planted: dir, next: '启动豆包 → 人工看侧栏两个视图 → scan → rollback' }, null, 2));
} else if (mode === 'scan') {
  const needles = [CHAT, TITLE];
  const out = { probeExists: fs.existsSync(dir), idb: {}, logs: {} };
  for (const r of roots) {
    const idb = path.join(r.userData, r.profile, 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb');
    if (!fs.existsSync(idb)) {
      out.idb[idb] = 'absent';
      continue;
    }
    const entries = readLevelDb(idb);
    const hits = [];
    for (const [k, e] of entries) {
      if (e.value == null) continue;
      const v = Buffer.from(e.value);
      const forms = [v.toString('latin1'), v.toString('utf16le')];
      for (const n of needles) if (forms.some((f) => f.includes(n))) hits.push(Buffer.from(k, 'latin1').toString('hex').slice(0, 40));
    }
    out.idb[idb] = { records: entries.size, hits: hits.length, sample: hits.slice(0, 5) };
  }
  const logDirs = { 'sdk_storage/log': path.join(root.userData, 'sdk_storage', 'log'), agent_infra: path.join(root.userData, root.profile, 'agent_infra') };
  for (const [name, d] of Object.entries(logDirs)) out.logs[name] = grepFiles(d, [CHAT, AGENT]) ?? 'absent';
  console.log(JSON.stringify(out, null, 2));
  console.log('// 判读：idb/logs 全 0 命中且 GUI 两视图也不列 → 本地写入不被采纳（阴性）。');
  console.log('// GUI 那腿要有同一天原生会话在列作对照，否则「不列」证明不了任何事。');
} else if (mode === 'rollback') {
  if (!fs.existsSync(dir)) {
    console.log(JSON.stringify({ ok: true, note: '探针目录本就不存在', sessions: listing() }, null, 2));
  } else {
    const found = walk(dir);
    const extras = found.filter((f) => !FILES.includes(f));
    if (extras.length) console.log(JSON.stringify({ deleted: null, files: found, hostWroteExtras: extras, sessionsNow: listing() }, null, 2));
    else fs.rmSync(dir, { recursive: true });
    // 删完再取清单：这一行要回答的是「探针消失后 .sessions 回到什么状态」，取早了就是假证据
    console.log(JSON.stringify({ deleted: extras.length ? null : dir, files: found, hostWroteExtras: extras, sessionsAfter: listing() }, null, 2));
    if (extras.length) console.log('!! 探针里有非本脚本创建的文件 —— 先人工核对再删，别直接 rm');
  }
} else {
  console.log(JSON.stringify({ root: root.path, sessions: listing(), probeExists: fs.existsSync(dir), profiles: roots.map((r) => r.profile) }, null, 2));
}
