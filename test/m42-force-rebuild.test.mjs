// M42 测试：--force 整份重建之后，「会话行」必须还在
//
// 四家库型 writer 都是「查既有行 → force 时 DELETE → 再写」，但删完之后各自用不同的条件决定
// 要不要重插会话行：
//   opencode / mimo(opencode-classic)：`if (!existing)` —— existing 是删除**之前**读到的，
//     于是 force 删完不再插，只剩消息行成孤儿（读回 0 轮、宿主列表里没有这条）；
//   zcode / minimax：`if (!existing || force)` —— force + append 时行还在，却又插一次 →
//     PRIMARY KEY 冲突，整条写入崩掉。
// 一条规则就够：删完了它就不存在了，按「现在还在不在」决定插还是改。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { makeSession, messageItem } from '../src/ir.mjs';
import { mkOpencodeDb, mkMimoDb, mkZcodeDb, mkMinimaxDb } from './db-fixtures.mjs';

const T0 = 1791484221000;
const ID = 'target-force-1';

function mk(n) {
  return makeSession({
    id: 's1', variant: 'claude', title: `重建校验 ${n}`, cwd: 'D:/work/demo',
    createdAt: T0, updatedAt: T0 + n * 60000, model: 'm-1',
    turns: Array.from({ length: n }, (_, i) => ({
      index: i, role: 'user', startedAt: T0 + i * 1000,
      items: [messageItem('user', `问${i}`, T0 + i * 1000), messageItem('assistant', `答${i}`, T0 + i * 1000)],
    })),
    meta: {},
  });
}

const CASES = {
  opencode: {
    table: 'session_v2',
    setup(root) {
      const data = path.join(root, 'ocdata');
      mkOpencodeDb(path.join(data, 'opencode.db'));
      return { env: { OPENCODE_DATA_DIR: data } };
    },
  },
  mimo: {
    table: 'session',
    setup(root) {
      const home = path.join(root, 'mimohome');
      mkMimoDb(path.join(home, 'mimocode.db'));
      return { env: { MIMO_HOME: home } };
    },
  },
  zcode: {
    table: 'session',
    setup(root) {
      const home = path.join(root, 'zcodehome');
      mkZcodeDb(path.join(home, 'cli', 'db', 'db.sqlite'), path.join(home, 'v2', 'tasks-index.sqlite'));
      return { env: { ZCODE_HOME: home } };
    },
  },
  minimax: {
    table: 'local_runtime_sessions',
    setup(root) {
      const home = path.join(root, 'mmhome');
      mkMinimaxDb(path.join(home, 'v2', 'sqlite', 'runtime-state.sqlite'));
      return { env: { MINIMAX_HOME: home } };
    },
  },
};

function rowCount(ctx, variant, table) {
  const dbFile = variant === 'opencode'
    ? path.join(ctx.env.OPENCODE_DATA_DIR, 'opencode.db')
    : variant === 'mimo'
      ? path.join(ctx.env.MIMO_HOME, 'mimocode.db')
      : variant === 'zcode'
        ? path.join(ctx.env.ZCODE_HOME, 'cli', 'db', 'db.sqlite')
        : path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite');
  const db = new DatabaseSync(dbFile);
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${variant === 'minimax' ? 'session_id' : 'id'} = ?`).get(ID).c);
  } finally {
    db.close();
  }
}

for (const [variant, spec] of Object.entries(CASES)) {
  const fresh = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m42-${variant}-`));
    const { env } = spec.setup(root);
    fs.mkdirSync(path.join(root, 'work', 'demo'), { recursive: true });
    return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env, cwd: path.join(root, 'work', 'demo') });
  };

  test(`${variant}：--force 重建后会话行必须还在，读回是新的全部内容`, () => {
    const ctx = fresh();
    const w = getWriter(variant);
    const first = w.write(ctx, { session: mk(2), targetId: ID, mode: 'create', provenance: null, force: true });
    assert.equal(first.ok, true, JSON.stringify(first));

    const again = w.write(ctx, { session: mk(3), targetId: ID, mode: 'create', provenance: null, force: true });
    assert.equal(again.ok, true, `force 重建应成功，实际 ${JSON.stringify(again)}`);
    assert.equal(rowCount(ctx, variant, spec.table), 1, '会话行必须被重新插回（删了不插 = 消息行成孤儿）');
  });

  test(`${variant}：append + force 不得重复插会话行`, () => {
    const ctx = fresh();
    const w = getWriter(variant);
    assert.equal(w.write(ctx, { session: mk(2), targetId: ID, mode: 'create', provenance: null, force: true }).ok, true);
    const r = w.write(ctx, { session: mk(3), targetId: ID, mode: 'append', fromTurnIndex: 2, provenance: null, force: true });
    assert.equal(r.ok, true, `追加时带着 force 不能崩，实际 ${JSON.stringify(r)}`);
    assert.equal(rowCount(ctx, variant, spec.table), 1, '追加不能产生第二条会话行');
  });
}
