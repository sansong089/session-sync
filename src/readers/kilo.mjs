// readers/kilo.mjs — Kilo Code：优先 opencode 同构 db，否则回退 VS Code 扩展任务目录（Cline 血统）
import { createOpencodeClassicReader } from './opencode-classic.mjs';
import { createClineFamilyReader } from './cline-family.mjs';
import { adoptSiblingIdentity } from './base.mjs';

const dbReader = createOpencodeClassicReader({ variant: 'kilo', provenanceSlot: 'permission' });
const tasksReader = createClineFamilyReader({ variant: 'kilo' });

export const kiloReader = {
  variant: 'kilo',
  label: 'Kilo Code',

  available(ctx) {
    return dbReader.available(ctx) || tasksReader.available(ctx);
  },

  list(ctx, opts = {}) {
    const out = [];
    if (dbReader.available(ctx)) out.push(...dbReader.list(ctx, opts));
    if (tasksReader.available(ctx)) out.push(...tasksReader.list(ctx, opts));
    // 7.8.18+ 的库排在前面；同 id 的合并由 listSessions 统一处理
    return out;
  },

  read(ctx, id) {
    const fromDb = dbReader.available(ctx) ? dbReader.read(ctx, id) : null;
    if (fromDb) {
      // 库是首选正文；老任务目录同 id 副本里的 provenance 用来补身份
      const fromTasks = fromDb.origin || !tasksReader.available(ctx) ? null : tasksReader.read(ctx, id);
      return adoptSiblingIdentity(fromDb, [fromTasks]);
    }
    if (tasksReader.available(ctx)) return tasksReader.read(ctx, id);
    return null;
  },
};
