// installer.mjs — skill 安装：共享根必装 + 各家桥接（自动探测）
//
// 设计：共享根 ~/.agents/skills/<name>/ 是唯一事实源（含 SKILL.md + bin + src + references）。
// 各家桥接只写一份「渲染后的 SKILL.md」，其中 CLI 路径指向共享根，避免多份代码副本。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_VARIANTS, VARIANTS, SHARED_SKILLS_ROOT } from './hosts.mjs';
import { detectInstalled } from './roots.mjs';
import { resolveRoot } from './roots.mjs';
import { ensureDir, isFile } from './util.mjs';

export const SKILL_NAME = 'session-sync';
export const CLI_PLACEHOLDER = '{{CLI}}';

const COPY_ENTRIES = ['SKILL.md', 'bin', 'src', 'references', 'package.json', 'README.md'];
const EXCLUDE = /(^|[\\/])(node_modules|test|\.tmp[^\\/]*|.*\.bak-\d+)([\\/]|$)/;

export function packageRoot() {
  return path.resolve(fileURLToPath(import.meta.url), '..', '..');
}

export function sharedSkillDir(ctx, rootOverride) {
  if (rootOverride) return path.join(path.resolve(rootOverride), SKILL_NAME);
  return path.join(SHARED_SKILLS_ROOT(ctx), SKILL_NAME);
}

function cliPathIn(skillDir) {
  return path.join(skillDir, 'bin', 'session-sync.mjs').replace(/\\/g, '/');
}

function renderSkillMd(template, cliPath) {
  return template.split(CLI_PLACEHOLDER).join(cliPath);
}

function readTemplate() {
  const file = path.join(packageRoot(), 'SKILL.md');
  if (!isFile(file)) throw new Error(`缺少 SKILL.md: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    filter: (s) => !EXCLUDE.test(s.replace(/\\/g, '/')),
  });
}

// Freebuff 无 skill 机制：生成 TS 薄封装模板（API 未公开文档化，标注为模板）
const FREEBUFF_WRAPPER = `/**
 * session-sync 薄封装（Freebuff / Codebuff）
 *
 * ⚠️ 模板文件：Freebuff 的 agent 定义 API 未公开文档化，字段名请按你当前版本调整。
 * 实际逻辑全部在共享根 CLI 里，这里只负责把自然语言请求转成一次 CLI 调用。
 *
 * CLI: {{CLI}}
 *
 * 典型用法（在会话里）：
 *   "把最近 7 天 codex 的会话同步过来"
 *     → node "{{CLI}}" import --from codex --since 7d --apply
 */
export const sessionSync = {
  id: 'session-sync',
  displayName: 'Session Sync（跨 agent 会话同步）',
  description:
    '在任意 coding agent 之间同步会话历史。幂等、跨链路去重、round-trip 收敛。' +
    '支持按时间范围/项目/多来源多目的地批量同步。',
  // 交给模型自行决定调用哪个子命令（detect / list / status / import / verify）
  instructions: [
    '你是会话同步助手。执行前先运行 detect 看清环境，再用 status 预览，最后 import --apply 落盘。',
    'CLI 绝对路径：{{CLI}}',
    '默认目标 = 当前 agent；用户说"导到 X"时才加 --into X。',
    '宿主装在自定义目录时，先看 detect 的逐家证据行；写侧要用 --data-root <变体>=<目录> 点名。',
  ].join('\\n'),
  command: 'node',
  args: ['{{CLI}}'],
};
`;

function freebuffWrapper(cwd, cliPath) {
  const dir = path.join(cwd, '.agents');
  const file = path.join(dir, 'session-sync.ts');
  ensureDir(dir);
  fs.writeFileSync(file, FREEBUFF_WRAPPER.split(CLI_PLACEHOLDER).join(cliPath), 'utf8');
  return file;
}

/**
 * @param {object} ctx makeCtx()
 * @param {object} opts {hosts?, root?, cwd?, dryRun?, force?, shared?, noBridge?}
 */
export function installSkill(ctx, opts = {}) {
  const actions = [];
  const warnings = [];
  const template = readTemplate();
  const sharedDir = sharedSkillDir(ctx, opts.root);
  const cli = cliPathIn(sharedDir);

  // ---- 1. 共享根（必装）----
  if (opts.shared === false) {
    warnings.push('已跳过共享根安装（--no-shared）：桥接将指向不存在的 CLI');
  } else {
    const existed = isFile(path.join(sharedDir, 'SKILL.md'));
    if (existed && !opts.force) {
      actions.push({ kind: 'shared', path: sharedDir, status: 'exists', note: '已存在，未覆盖（--force 可覆盖）' });
    } else if (opts.dryRun) {
      actions.push({ kind: 'shared', path: sharedDir, status: 'would-install' });
    } else {
      ensureDir(sharedDir);
      for (const entry of COPY_ENTRIES) {
        const src = path.join(packageRoot(), entry);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(sharedDir, entry);
        if (fs.statSync(src).isDirectory()) copyTree(src, dst);
        else fs.copyFileSync(src, dst);
      }
      // 渲染后的 SKILL.md（CLI 指向本目录）
      fs.writeFileSync(path.join(sharedDir, 'SKILL.md'), renderSkillMd(template, cli), 'utf8');
      writeLaunchers(sharedDir);
      actions.push({ kind: 'shared', path: sharedDir, status: existed ? 'reinstalled' : 'installed' });
    }
  }

  // ---- 2. 决定桥接目标 ----
  let targets = opts.hosts;
  if (!targets || targets.length === 0) {
    const installed = detectInstalled(ctx);
    // 有 skill 目录的要桥接；无 skill 目录但直读共享根的（如 codex）也要列出，便于说明
    targets = installed.filter((v) => resolveRoot(v, ctx).skillsDir || v === 'freebuff' || VARIANTS[v].sharedDirect);
    actions.push({ kind: 'detect', path: '-', status: 'auto', note: `探测到 ${targets.length} 个候选宿主` });
  }
  if (opts.noBridge) targets = [];

  // ---- 3. 逐个桥接 ----
  for (const v of targets) {
    const variant = VARIANTS[v];
    if (!variant) {
      warnings.push(`未知变体: ${v}`);
      continue;
    }
    const skillsDir = resolveRoot(v, ctx).skillsDir;

    if (!skillsDir) {
      // 无 skill 机制的宿主：Freebuff 走 TS 薄封装
      if (v === 'freebuff') {
        const cwd = opts.cwd || process.cwd();
        if (opts.dryRun) {
          actions.push({ kind: 'bridge', variant: v, path: path.join(cwd, '.agents', 'session-sync.ts'), status: 'would-write', note: 'TS 薄封装模板' });
        } else {
          const file = freebuffWrapper(cwd, cli);
          actions.push({ kind: 'bridge', variant: v, path: file, status: 'written', note: 'TS 薄封装模板（字段名可能需按版本调整）' });
        }
      } else {
        actions.push({ kind: 'bridge', variant: v, path: '-', status: 'skipped', note: '直读共享根，无需桥接' });
      }
      continue;
    }

    const dir = path.join(skillsDir, SKILL_NAME);
    const file = path.join(dir, 'SKILL.md');
    if (isFile(file) && !opts.force) {
      actions.push({ kind: 'bridge', variant: v, path: file, status: 'exists', note: '已存在（--force 覆盖）' });
      continue;
    }
    if (opts.dryRun) {
      actions.push({ kind: 'bridge', variant: v, path: file, status: 'would-write' });
      continue;
    }
    ensureDir(dir);
    fs.writeFileSync(file, renderSkillMd(template, cli), 'utf8');
    actions.push({ kind: 'bridge', variant: v, path: file, status: 'written' });
  }

  // ok 必须从**实际结果**推导。
  // 原来这里恒 true：于是 `--no-shared`（共享根没装，桥接却已经写出去、指向一个不存在的
  // CLI）也算安装成功，调用方（脚本 / 上层 agent）无法区分「装好了」和「装了一半」。
  const dangling = !opts.dryRun && opts.shared === false
    && actions.some((a) => a.kind === 'bridge' && a.status === 'written');
  const failed = actions.filter((a) => a.status === 'failed');
  const ok = !dangling && failed.length === 0;
  if (dangling) warnings.push('共享根被跳过，但桥接文件已经写出去：它们指向的 CLI 不存在，装上也用不了');
  return { ok, sharedDir, cli, actions, warnings, ...(dangling ? { error: 'dangling-bridge: 共享根未安装，桥接指向不存在的 CLI' } : {}) };
}

// Windows 下额外给 .cmd / .sh 启动器，方便在终端直接敲
function writeLaunchers(sharedDir) {
  const bin = path.join(sharedDir, 'bin');
  ensureDir(bin);
  const sh = path.join(bin, 'session-sync');
  fs.writeFileSync(sh, '#!/usr/bin/env node\nimport("./session-sync.mjs");\n', 'utf8');
  const cmd = path.join(bin, 'session-sync.cmd');
  fs.writeFileSync(cmd, '@echo off\r\nnode "%~dp0session-sync.mjs" %*\r\n', 'utf8');
}

export function uninstallSkill(ctx, opts = {}) {
  const actions = [];
  const sharedDir = sharedSkillDir(ctx, opts.root);
  const targets = opts.hosts && opts.hosts.length > 0 ? opts.hosts : ALL_VARIANTS;

  for (const v of targets) {
    if (!VARIANTS[v]) continue;
    const skillsDir = resolveRoot(v, ctx).skillsDir;
    if (!skillsDir) {
      // Freebuff 没有 skill 目录，装的时候写的是 <cwd>/.agents/session-sync.ts。
      // 不删它，卸载就永远留一个指向已删除 CLI 的封装 —— 而且用户以为已经卸干净了。
      if (v === 'freebuff') {
        const file = path.join(opts.cwd || process.cwd(), '.agents', 'session-sync.ts');
        if (fs.existsSync(file)) {
          if (!opts.dryRun) fs.rmSync(file, { force: true });
          actions.push({ kind: 'bridge', variant: v, path: file, status: opts.dryRun ? 'would-remove' : 'removed', note: 'TS 薄封装' });
        }
      }
      continue;
    }
    const dir = path.join(skillsDir, SKILL_NAME);
    if (!fs.existsSync(dir)) continue;
    if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true });
    actions.push({ kind: 'bridge', variant: v, path: dir, status: opts.dryRun ? 'would-remove' : 'removed' });
  }

  if (opts.purge) {
    if (fs.existsSync(sharedDir)) {
      if (!opts.dryRun) fs.rmSync(sharedDir, { recursive: true, force: true });
      actions.push({ kind: 'shared', path: sharedDir, status: opts.dryRun ? 'would-remove' : 'removed' });
    }
  } else {
    actions.push({ kind: 'shared', path: sharedDir, status: 'kept', note: '加 --purge 一并删除' });
  }

  // --purge 时顺手清空父目录：安装会 ensureDir(~/.agents/skills/session-sync)，
  // 只删最内层就留下一串空壳，「卸载干净」变成一句空话
  if (opts.purge && !opts.dryRun) {
    for (const dir of [path.dirname(sharedDir), path.dirname(path.dirname(sharedDir))]) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
          actions.push({ kind: 'shared-parent', path: dir, status: 'removed', note: '空目录' });
        } else break;
      } catch {
        break;
      }
    }
  }
  return { ok: true, actions };
}
