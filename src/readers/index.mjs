// readers/index.mjs — reader 注册表
import { opencodeReader } from './opencode.mjs';
import { createOpencodeClassicReader } from './opencode-classic.mjs';
import { minimaxReader } from './minimax.mjs';
import { createQoderReader } from './qoder.mjs';
import { cursorReader } from './cursor.mjs';
import { kiloReader } from './kilo.mjs';
import { createClineFamilyReader } from './cline-family.mjs';
import { createWorkbuddyReader } from './workbuddy.mjs';
import { claudeReader } from './claude.mjs';
import { piReader } from './pi.mjs';
import { codexReader } from './codex.mjs';
import { codebuddyReader } from './codebuddy.mjs';
import { codebuddyIdeReader } from './codebuddy-ide.mjs';
import { freebuffReader } from './freebuff.mjs';
import { dshReader } from './dsh.mjs';
import { antigravityReader } from './antigravity.mjs';
import { zcodeReader } from './zcode.mjs';
import { doubaoReader } from './doubao.mjs';
import { withClassification, mergeSessions } from './base.mjs';
import { resolveRoot } from '../roots.mjs';

export const READERS = {
  opencode: opencodeReader,
  claude: claudeReader,
  pi: piReader,
  antigravity: antigravityReader,
  codex: codexReader,
  codebuddy: codebuddyReader,
  'codebuddy-ide': codebuddyIdeReader,
  'workbuddy-cn': createWorkbuddyReader({ variant: 'workbuddy-cn' }),
  'workbuddy-intl': createWorkbuddyReader({ variant: 'workbuddy-intl' }),
  'qoder-cn': createQoderReader({ variant: 'qoder-cn' }),
  'qoder-intl': createQoderReader({ variant: 'qoder-intl' }),
  zcode: zcodeReader,
  mimo: createOpencodeClassicReader({ variant: 'mimo', provenanceSlot: 'permission' }),
  minimax: minimaxReader,
  dsh: dshReader,
  freebuff: freebuffReader,
  cline: createClineFamilyReader({ variant: 'cline' }),
  kilo: kiloReader,
  roo: createClineFamilyReader({ variant: 'roo' }),
  cursor: cursorReader,
  doubao: doubaoReader,
};

export function getReader(variant) {
  return READERS[variant] ?? null;
}

export function readerStatus(variant) {
  const r = READERS[variant];
  if (!r) return { variant, implemented: false };
  return { variant, implemented: true, label: r.label };
}

export function listSessions(variant, ctx, opts = {}) {
  const r = getReader(variant);
  if (!r) return { ok: false, error: 'reader-not-implemented', variant, sessions: [], conflicts: [] };
  // 「装了没有」只在 resolveRoot().installed 一处判定（含 marker 探测）；
  // r.available(ctx) 留给 reader 自己挑代际/挑库（那是「读哪一份」，不是「这家在不在」）。
  if (!resolveRoot(variant, ctx).installed) return { ok: true, variant, available: false, sessions: [], conflicts: [] };
  try {
    // 源侧合并只在这一处做：reader 只负责「按来源顺序给出候选」，不各自去重
    const merged = mergeSessions(r.list(ctx, opts).map((s) => withClassification(s, ctx)));
    return { ok: true, variant, available: true, sessions: merged.sessions, conflicts: merged.conflicts };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), variant, sessions: [], conflicts: [] };
  }
}

export function readSession(variant, ctx, id) {
  const r = getReader(variant);
  if (!r) return { ok: false, error: 'reader-not-implemented', variant, session: null };
  try {
    const session = r.read(ctx, id);
    return { ok: true, variant, session: session ? withClassification(session, ctx) : session };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), variant, session: null };
  }
}
