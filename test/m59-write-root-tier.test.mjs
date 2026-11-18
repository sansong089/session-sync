// M59 测试：写侧取根必须按档位取 —— 钉住（flag）压过任何已存在的默认位置
//
// S7 真机闭环暴露的缺口：写侧取根时按「谁存在」挑，默认位置上有个旧目录就把
// 用户点名（--data-root）的意思吃掉了 —— 探测读得到、钉住却写不进去。
// 这里把「档位优先、档内才比存在性」钉死，并覆盖四家曾自抄 env 链的 writer。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { parseDataRoots, writeRootOf, roleRoots } from '../src/roots.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m59-${name}-`));
}
const ctxFor = (home, env = {}, extra = {}) =>
  makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env, ...extra });

test('flag 档压过已存在的 default 位置：钉住就是钉住', () => {
  const home = tmpHome('flag-wins');
  try {
    // 默认位置上放一个真实存在的目录（模拟「宿主以前装在默认位置、后来搬走了」）
    fs.mkdirSync(path.join(home, '.cline', 'data', 'sessions'), { recursive: true });
    const pinned = path.join(home, 'moved', '.cline');
    fs.mkdirSync(pinned, { recursive: true });
    const ctx = ctxFor(home, {}, { dataRoots: parseDataRoots(`cline=${pinned}`) });

    const hit = writeRootOf('cline', ctx, 'sessions');
    assert.ok(hit, '必须能取到根');
    assert.equal(hit.tier, 'flag', '档位必须是 flag');
    assert.equal(path.normalize(hit.path), path.normalize(path.join(pinned, 'data', 'sessions')), `钉住的位置必须生效，实际 ${hit.path}`);

    const tasks = writeRootOf('cline', ctx, 'tasks');
    assert.equal(tasks.tier, 'flag', 'tasks 档同样必须是 flag');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('不钉住时：已存在的 default 位置照旧可用（别把正常写入也拦了）', () => {
  const home = tmpHome('no-flag');
  try {
    const sessions = path.join(home, '.cline', 'data', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const ctx = ctxFor(home);
    const hit = writeRootOf('cline', ctx, 'sessions');
    assert.equal(path.normalize(hit.path), path.normalize(sessions));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('env 档压过 default 档（宿主自己声明的落点优先于默认位置）', () => {
  const home = tmpHome('env-wins');
  try {
    fs.mkdirSync(path.join(home, '.cline', 'data', 'sessions'), { recursive: true });
    const moved = path.join(home, 'moved', 'data', 'sessions');
    fs.mkdirSync(moved, { recursive: true });
    const ctx = ctxFor(home, { CLINE_SESSION_DATA_DIR: moved });
    const hit = writeRootOf('cline', ctx, 'sessions');
    assert.equal(path.normalize(hit.path), path.normalize(moved), `env 指定的落点必须赢，实际 ${hit.path}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('写侧四个「曾自抄 env 链」的落点都按 role 登记（roleRoots 能取到）', () => {
  const home = tmpHome('roles');
  try {
    const ctx = ctxFor(home);
    // claude：项目正文根；minimax：历史目录；codebuddy-ide：扩展数据根；cline：会话库与索引
    assert.ok(roleRoots('claude', ctx, 'projects').length >= 1, 'claude 缺 projects role');
    assert.ok(roleRoots('minimax', ctx, 'history').length >= 1, 'minimax 缺 history role');
    assert.ok(roleRoots('codebuddy-ide', ctx, 'data').length >= 1, 'codebuddy-ide 缺 data role');
    assert.ok(roleRoots('cline', ctx, 'sessions').length >= 1, 'cline 缺 sessions role');
    assert.ok(roleRoots('cline', ctx, 'sessionsIndex').length >= 1, 'cline 缺 sessionsIndex role');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('钉住 claude 时，写侧的项目正文根跟着钉住走（写进钉住的位置，不写默认位置）', () => {
  const home = tmpHome('claude-pin');
  try {
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const pinned = path.join(home, 'moved', '.claude');
    fs.mkdirSync(pinned, { recursive: true });
    const ctx = ctxFor(home, {}, { dataRoots: parseDataRoots(`claude=${pinned}`) });
    const hit = writeRootOf('claude', ctx, 'projects');
    assert.equal(path.normalize(hit.path), path.normalize(path.join(pinned, 'projects')), `实际 ${hit.path}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
