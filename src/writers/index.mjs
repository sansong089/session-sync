// writers/index.mjs — writer 注册表
import { claudeWriter } from './claude.mjs';
import { createWorkbuddyWriter } from './workbuddy.mjs';
import { piWriter } from './pi.mjs';
import { codexWriter } from './codex.mjs';
import { codebuddyWriter } from './codebuddy.mjs';
import { codebuddyIdeWriter } from './codebuddy-ide.mjs';
import { freebuffWriter } from './freebuff.mjs';
import { createClineFamilyWriter } from './cline.mjs';
import { opencodeWriter } from './opencode.mjs';
import { createOpencodeClassicWriter } from './opencode-classic.mjs';
import { dshWriter } from './dsh.mjs';
import { zcodeWriter } from './zcode.mjs';
import { minimaxWriter } from './minimax.mjs';
import { createQoderWriter } from './qoder.mjs';
import { isFile, isDir } from '../util.mjs';
import { roleRoots } from '../roots.mjs';
import { configRoot } from '../hosts.mjs';
import { normalizeTurnItems } from '../ir.mjs';

const clineFamily = createClineFamilyWriter({ variant: 'cline' });
const kiloTasks = createClineFamilyWriter({ variant: 'kilo' });
const kiloClassic = createOpencodeClassicWriter({ variant: 'kilo' });
const rooFamily = createClineFamilyWriter({ variant: 'roo' });

/**
 * Kilo 的存储代际（2026-10-27 源码取证）：
 *   - `db`：7.8.18+ 的 `<data>/kilo.db`（OpenCode 血统 project/session/message/part）
 *   - `tasks`：≤5.16.2 的 VS Code 扩展任务目录 + `globalState.taskHistory`
 *   - `null`：本机两代都没有，且配置根也不在 —— 这家压根没装
 *
 * 第三态是必须的。原来是 `kilo.db 存在 ? 库 : 任务目录`：两代都没有时会一路走到任务目录写侧，
 * 把「这台机器上没有 Kilo」变成「在 ~/.kilo/tasks 下造一条宿主永远不会看的会话」。
 * 反过来「装过但一次都没跑」（配置根在、两代存储都空）要照常可写 —— 那正是新建会话该有的样子。
 * 两代并存时以库为准：升级不会删旧任务目录，而新版宿主只读库。
 */
function kiloWriterOf(ctx) {
  if (roleRoots('kilo', ctx, 'db').some((x) => x.kind === 'file' && isFile(x.path))) return { gen: 'db', writer: kiloClassic };
  if (roleRoots('kilo', ctx, 'tasks').some((x) => x.kind === 'dir' && isDir(x.path))) return { gen: 'tasks', writer: kiloTasks };
  if (isDir(configRoot(ctx, 'kilo'))) return { gen: 'tasks', writer: kiloTasks };
  return { gen: null, writer: null };
}

const KILO_ABSENT = 'kilo-store-absent'; // 两代存储都不在、配置根也不在 → 不是「要新建」，是「这家没装」

const kiloWriter = {
  variant: 'kilo',
  label: 'Kilo Code',
  canWrite(ctx) {
    const { writer } = kiloWriterOf(ctx);
    return writer ? writer.canWrite(ctx) : { ok: false, reason: KILO_ABSENT };
  },
  targetPath(ctx, session, targetId) {
    return kiloWriterOf(ctx).writer?.targetPath?.(ctx, session, targetId) ?? null;
  },
  write(ctx, args) {
    const { writer } = kiloWriterOf(ctx);
    return writer ? writer.write(ctx, args) : { ok: false, error: KILO_ABSENT };
  },
  // 标题同步按代际分派：db 代（7.8.18+）标题在 session.title 列，任务目录代没有单一落点。
  // 两个被转发的 writer 都是槽机制（makeTitleSyncer 造的），这里只是按代际选哪一个 ——
  // 标记同样打上，结构门禁据此认定「没有手写第二套」。
  syncTitle: Object.assign(
    function syncTitle(ctx, args) {
      const { writer } = kiloWriterOf(ctx);
      // 没有落点不是失败：标题同步是「能改就改」的补偿动作，这家没装就该安静跳过（幂等空操作）
      if (!writer) return { ok: true, skipped: true, reason: KILO_ABSENT };
      return writer.syncTitle(ctx, args);
    },
    { __fromTitleSlots: true },
  ),
};

export const WRITERS = {
  // Tier A：文件/JSONL 直写
  'qoder-cn': createQoderWriter({ variant: 'qoder-cn' }),
  'qoder-intl': createQoderWriter({ variant: 'qoder-intl' }),
  claude: claudeWriter,
  'workbuddy-cn': createWorkbuddyWriter({ variant: 'workbuddy-cn' }),
  'workbuddy-intl': createWorkbuddyWriter({ variant: 'workbuddy-intl' }),
  pi: piWriter,
  codex: codexWriter,
  codebuddy: codebuddyWriter,
  'codebuddy-ide': codebuddyIdeWriter,
  freebuff: freebuffWriter,
  cline: clineFamily,
  kilo: kiloWriter,
  roo: rooFamily,
  // Tier B：库/压缩容器
  opencode: opencodeWriter,
  mimo: createOpencodeClassicWriter({ variant: 'mimo' }),
  zcode: zcodeWriter,
  minimax: minimaxWriter,
  dsh: dshWriter,
};

// 写侧唯一入口：各家降级附件的格式不同，但「附件排在本轮用户消息之前」对它们是同一个坑
// （轮首附件 → 先发 assistant 占位消息 → 读侧多开一轮）。输入契约在这里统一，不在 12 个 writer 里各修一遍。
// 就地改 write：注册表对象本身仍是可就地替换方法的那一个（repair/syncTitle 的 mock 依赖这一点）。
const NORMALIZED_WRITERS = new Set();

export function getWriter(variant) {
  const w = WRITERS[variant];
  if (!w) return null;
  if (!NORMALIZED_WRITERS.has(variant)) {
    const orig = w.write;
    w.write = function write(ctx, args) {
      const src = args?.session;
      if (!Array.isArray(src?.turns)) return orig.call(this, ctx, args);
      const turns = src.turns.map(normalizeTurnItems);
      if (turns.every((t, i) => t === src.turns[i])) return orig.call(this, ctx, args);
      return orig.call(this, ctx, { ...args, session: { ...src, turns } });
    };
    NORMALIZED_WRITERS.add(variant);
  }
  return w;
}

export function hasWriter(variant) {
  return !!WRITERS[variant];
}

export const WRITABLE_VARIANTS = Object.keys(WRITERS);
