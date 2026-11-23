// selftest.mjs — 环境与核心逻辑自检（node:test 之外的一键体检）
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import {
  NODE_ENGINE_MIN, NAMESPACE_DNS, nodeVersion, versionAtLeast, uuid5, uuidv7, sha256hex, stableStringify,
} from './util.mjs';
import { ALL_VARIANTS, VARIANTS, LOCATOR, skillsDirOf, makeCtx } from './hosts.mjs';
import { READERS } from './readers/index.mjs';
import { WRITERS } from './writers/index.mjs';
import { originKeyOf, mintTargetId, mintForkId, targetSessionId, forkSessionId, forkBranchKey } from './identity.mjs';
import { buildProvenance, provenanceFromObject, provenanceSummary, embedInJsonObject, extractFromJsonObject } from './provenance.mjs';
import { decideAction } from './diff.mjs';
import { makeSession, makeTurn, messageItem, reasoningItem, sessionFingerprints } from './ir.mjs';

export function runSelftest() {
  const checks = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, status: 'pass', detail: detail ?? '' });
    } catch (err) {
      checks.push({ name, status: 'fail', detail: String(err?.message ?? err) });
    }
  };
  const checkWarn = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, status: 'pass', detail: detail ?? '' });
    } catch (err) {
      checks.push({ name, status: 'warn', detail: String(err?.message ?? err) });
    }
  };

  check('node-engine', () => {
    const v = nodeVersion();
    if (!versionAtLeast(v, NODE_ENGINE_MIN)) throw new Error(`node ${v} < ${NODE_ENGINE_MIN.join('.')}`);
    return v;
  });

  check('node:sqlite', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a INTEGER)');
    db.prepare('INSERT INTO t VALUES(?)').run(1);
    const row = db.prepare('SELECT a FROM t').get();
    db.close();
    if (row.a !== 1) throw new Error('roundtrip failed');
    return 'ok';
  });

  checkWarn('node:zlib:zstd', () => {
    if (typeof zlib.zstdCompressSync !== 'function') throw new Error('zstdCompressSync 不可用（需 node>=22.15；仅影响 dsh 读写）');
    const c = zlib.zstdCompressSync(Buffer.from('hello'));
    const d = zlib.zstdDecompressSync(c).toString();
    if (d !== 'hello') throw new Error('roundtrip failed');
    return 'ok';
  });

  check('variant-registry', () => {
    if (ALL_VARIANTS.length !== 21) throw new Error(`expected 21 variants, got ${ALL_VARIANTS.length}`);
    const readers = ALL_VARIANTS.filter((v) => VARIANTS[v].read);
    const writers = ALL_VARIANTS.filter((v) => VARIANTS[v].write);
    if (readers.length !== 21) throw new Error(`readers=${readers.length}`);
    if (writers.length !== 19) throw new Error(`writers=${writers.length}`);
    // 实际落地的 reader/writer 实现数（reader/writer 注册表）
    const implReaders = ALL_VARIANTS.filter((v) => READERS[v]).length;
    if (implReaders !== 21) throw new Error(`impl readers=${implReaders}`);
    const implWriters = ALL_VARIANTS.filter((v) => WRITERS[v]).length;
    if (implWriters < 1) throw new Error('no writer implemented');
    return `21 variants, ${implReaders} readers, ${implWriters} writers (capability ${writers.length})`;
  });

  check('uuid5-format', () => {
    const a = uuid5('x', NAMESPACE_DNS);
    const b = uuid5('x', NAMESPACE_DNS);
    if (a !== b) throw new Error('not deterministic');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a)) throw new Error(`bad uuid5: ${a}`);
    const c = uuid5('y', NAMESPACE_DNS);
    if (a === c) throw new Error('collision');
    return a;
  });

  check('uuidv7-order', () => {
    const a = uuidv7(1700000000000);
    const b = uuidv7(1700000000001);
    if (a >= b) throw new Error('not time-ordered');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a)) throw new Error(`bad uuidv7: ${a}`);
    return a;
  });

  check('identity-determinism', () => {
    const src = makeSession({ id: 'X', variant: 'codex', turns: [makeTurn('user', [messageItem('user', 'hi')])] });
    const k = originKeyOf(src);
    if (k !== 'codex:X') throw new Error(`originKey=${k}`);
    const id1 = targetSessionId('pi', src);
    const id2 = targetSessionId('pi', src);
    if (id1 !== id2) throw new Error('target id not deterministic');
    const f1 = forkSessionId('pi', src, sha256hex('div'));
    const f2 = forkSessionId('pi', src, sha256hex('div'));
    if (f1 !== f2) throw new Error('fork id not deterministic');
    if (f1 === id1) throw new Error('fork id collides with import id');
    if (mintTargetId('pi', k) !== id1) throw new Error('mintTargetId mismatch');
    if (mintForkId('pi', k, sha256hex('div')) !== f1) throw new Error('mintForkId mismatch');
    return `originKey=${k} pi=${id1}`;
  });

  check('identity-family-shapes', () => {
    const k = 'codex:X';
    const expect = {
      'workbuddy-cn': /^[0-9a-f-]{36}$/,
      'workbuddy-intl': /^[0-9a-f-]{36}$/,
      claude: /^[0-9a-f-]{36}$/,
      pi: /^[0-9a-f-]{36}$/,
      codex: /^[0-9a-f-]{36}$/,
      codebuddy: /^[0-9a-f-]{36}$/, 'codebuddy-ide': /^[0-9a-f]{32}$/,
      opencode: /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
      dsh: /^[0-9a-f-]{36}$/,
      cursor: /^[0-9a-f-]{36}$/,
      mimo: /^ses_[0-9a-f]{22}$/,
      zcode: /^sess_[0-9a-f-]{36}$/,
      kilo: /^[0-9a-f-]{36}$/,
      minimax: /^mvs_[0-9a-f]{32}$/,
      freebuff: /^sync-[0-9a-f]{16}$/,
      'qoder-cn': /^[0-9a-f]{20}$/,
      'qoder-intl': /^[0-9a-f]{20}$/,
      cline: /^\d{13}$/,
    };
    for (const [variant, re] of Object.entries(expect)) {
      const id = mintTargetId(variant, k);
      if (!re.test(id)) throw new Error(`${variant}: bad id shape ${id}`);
    }
    // 只读集合（能作源不能作目标）；zcode/minimax 已按取证结论转为可写
    const readonly = ['cursor', 'doubao'];
    for (const v of readonly) {
      if (VARIANTS[v].write !== false) throw new Error(`${v} must be unwritable`);
    }
    return 'ok';
  });

  check('roundtrip-native-id', () => {
    const native = makeSession({ id: 'W', variant: 'workbuddy-cn' });
    if (targetSessionId('workbuddy-cn', native) !== 'W') throw new Error('native round-trip must keep native id');
    const viaCodex = makeSession({ id: 'P', variant: 'pi', origin: { variant: 'workbuddy-cn', sessionId: 'W' }, chain: [{ variant: 'workbuddy-cn', sessionId: 'W', at: 1 }] });
    if (targetSessionId('workbuddy-cn', viaCodex) !== 'W') throw new Error('round-trip via pi must converge to native W');
    return 'ok';
  });

  check('provenance-roundtrip', () => {
    const src = makeSession({ id: 'X', variant: 'codex' });
    const p1 = buildProvenance(src, 1000);
    const obj = embedInJsonObject({ composerId: 'c1' }, p1);
    const p2 = extractFromJsonObject(obj);
    const parsed = provenanceFromObject(p2);
    if (!parsed) throw new Error('extract failed');
    if (parsed.origin.variant !== 'codex' || parsed.origin.sessionId !== 'X') throw new Error('origin mismatch');
    if (parsed.chain.length !== 1 || parsed.chain[0].variant !== 'codex') throw new Error('chain mismatch');
    // 二次中转：chain 追加，origin 不变
    const hop = makeSession({ id: 'P', variant: 'pi', origin: parsed.origin, chain: parsed.chain });
    const p3 = buildProvenance(hop, 2000);
    if (p3.chain.length !== 2 || p3.chain[1].variant !== 'pi') throw new Error('chain not extended');
    if (p3.origin.variant !== 'codex') throw new Error('origin drifted');
    if (provenanceSummary(p3) !== 'codex:X → codex:X → pi:P') throw new Error(`summary: ${provenanceSummary(p3)}`);
    return 'ok';
  });

  check('diff-decisions', () => {
    const mk = (n) => makeSession({
      id: 'S', variant: 'codex',
      turns: Array.from({ length: n }, (_, i) => makeTurn(i % 2 === 0 ? 'user' : 'assistant', [messageItem(i % 2 === 0 ? 'user' : 'assistant', `m${i}`)])),
    });
    const src = mk(3);
    // create
    if (decideAction(src, null).action !== 'create') throw new Error('create');
    // skip（一致）
    if (decideAction(src, mk(3)).action !== 'skip') throw new Error('skip identical');
    // target ahead
    if (decideAction(mk(2), mk(3), true).action !== 'skip') throw new Error('skip target-ahead');
    // append（身份相同 + 目标是源的严格前缀；原生/导入一律允许）
    const r1 = decideAction(mk(3), mk(2), true);
    if (r1.action !== 'append' || r1.at !== 2) throw new Error(`append: ${JSON.stringify(r1)}`);
    // fork（双方分叉）
    const dst = mk(2);
    dst.turns[1].items[0].text = 'changed';
    const r2 = decideAction(mk(3), dst, true);
    if (r2.action !== 'fork' || typeof r2.at !== 'number') throw new Error(`fork: ${JSON.stringify(r2)}`);
    // 身份不同 → 绝不 append/skip，fork 且标 identity-mismatch
    const r3 = decideAction(mk(3), mk(2), false);
    if (r3.action !== 'fork' || r3.reason !== 'identity-mismatch') throw new Error(`identity mismatch: ${JSON.stringify(r3)}`);
    // fork 确定性：同一分歧点得到同一分支坐标，且分支继续增长时坐标不变
    // （旧的整段后缀哈希每续一轮就换 ID，会累积出多条近似 fork）
    const at = decideAction(mk(3), dst, true).at;
    const h1 = forkBranchKey('base', at, mk(3).turns[at]);
    const h2 = forkBranchKey('base', at, mk(5).turns[at]);
    if (h1 !== h2) throw new Error('fork branch key not stable across growth');
    return 'ok';
  });

  check('fingerprint-stable', () => {
    const t1 = makeTurn('user', [messageItem('user', 'hello', 111)]);
    const t2 = makeTurn('user', [messageItem('user', 'hello', 999)]);
    const s1 = makeSession({ id: 'a', variant: 'codex', turns: [t1] });
    const s2 = makeSession({ id: 'b', variant: 'codex', turns: [t2] });
    if (sessionFingerprints(s1)[0] !== sessionFingerprints(s2)[0]) throw new Error('fingerprint must ignore ts/id');
    const withReasoning = makeSession({ id: 'a', variant: 'codex', turns: [makeTurn('user', [messageItem('user', 'hello'), reasoningItem('think')])] });
    if (sessionFingerprints(withReasoning)[0] === sessionFingerprints(s1)[0]) throw new Error('fingerprint must see content diff');
    return 'ok';
  });

  check('hosts-paths-resolve', () => {
    const ctx = makeCtx({ home: '/home/tester', platform: 'linux', env: {} });
    for (const name of ALL_VARIANTS) {
      const v = VARIANTS[name];
      if (typeof v.readPaths !== 'function') throw new Error(`${name}: readPaths missing`);
      const paths = v.readPaths(ctx);
      if (!Array.isArray(paths) || paths.length === 0) throw new Error(`${name}: no read paths`);
      for (const x of paths) if (!x.path || typeof x.path !== 'string') throw new Error(`${name}: bad path ${x.path}`);
    }
    const withSkills = ALL_VARIANTS.filter((n) => LOCATOR[n].skills);
    if (withSkills.length !== 17) throw new Error(`skills 登记数=${withSkills.length} (expected 17; codex/codebuddy-ide/freebuff 无 skill 机制)`);
    for (const name of ALL_VARIANTS) {
      if (!LOCATOR[name]) throw new Error(`${name}: locator missing`);
      if (typeof LOCATOR[name].root !== 'function') throw new Error(`${name}: locator.root missing`);
      if (!LOCATOR[name].bucket) throw new Error(`${name}: locator.bucket missing（没有桶也要声明 shape:'none'）`);
      if (!skillsDirOf(ctx, name) && LOCATOR[name].skills) throw new Error(`${name}: 声明了 skills 却算不出目录`);
    }
    return 'ok';
  });

  check('stable-stringify', () => {
    const a = stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] });
    const b = stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 });
    if (a !== b) throw new Error('key order not normalized');
    return 'ok';
  });

  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  return { ok: fails.length === 0, checks, summary: { pass: checks.length - fails.length - warns.length, warn: warns.length, fail: fails.length } };
}
