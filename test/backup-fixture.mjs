// 备份断言用的共享夹具：备份落点只有一个（~/.session-sync/backups/<变体>/），
// 五个测试文件都要断言「写前留了备份、且宿主扫描根里没留下 .bak」，抽一份免得各写一遍。
import fs from 'node:fs';
import path from 'node:path';

export function backupRoot(home, variant) {
  return path.join(home, '.session-sync', 'backups', variant);
}

/** 变体备份目录下的全部文件（镜像了原路径，所以是递归） */
export function backupsOf(home, variant) {
  const dir = backupRoot(home, variant);
  const out = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 宿主扫描根里残留的 .bak（必须永远是 0） */
export function strayBackups(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes('.bak-')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
