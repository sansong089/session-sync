// lock.mjs — 跨进程文件锁（零依赖）
//
// 用途：允许在目标 agent 正在运行时导入。两类并发要挡：
//   1. 我们自己：多个 session-sync 进程同时写同一个目标
//   2. 宿主：宿主随时可能往同一批文件/库追加内容（无法加锁，只能靠原子写 + 写前重校验）
// 本模块解决第 1 类；第 2 类见 writers/base.mjs 的原子写与 import.mjs 的写前重校验。
//
// 锁文件放 os.tmpdir()（同机同用户可见，随进程消亡自然失效）：
//   创建用 O_EXCL（'wx'）保证原子；持有者 pid 已死或超时未释放视为陈旧锁，可抢占。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 锁目录：默认 os.tmpdir()/session-sync-locks（同机同用户可见），
// 可用 SESSION_SYNC_LOCK_DIR 指向别处 —— 并行跑的测试文件靠它隔离，否则会互抢同一个 key
function resolveLockDir() {
  return process.env.SESSION_SYNC_LOCK_DIR || path.join(os.tmpdir(), 'session-sync-locks');
}

// 同进程内可重入：避免同一 key 被自己二次获取时死等
const held = new Map();

export function lockPathFor(key) {
  const h = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
  return path.join(resolveLockDir(), `${h}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限（跨用户场景），仍视为存活
    return err?.code === 'EPERM';
  }
}

// 同步 sleep（不阻塞事件循环以外的东西；本工具是同步 CLI，够用）
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy wait fallback */
    }
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 获取锁。
 * @param {string} key 锁键（建议 `target:<变体>`）
 * @param {object} opts {timeoutMs=30000, staleMs=300000, pollMs=60}
 * @returns {{ok:boolean, release:Function, waitedMs:number, error?:string, holder?:object}}
 */
export function acquireLock(key, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const staleMs = opts.staleMs ?? 300000;
  const pollMs = opts.pollMs ?? 60;
  const k = String(key);

  // 同进程重入
  const existing = held.get(k);
  if (existing) {
    existing.count++;
    return {
      ok: true,
      reentrant: true,
      waitedMs: 0,
      release() {
        existing.count--;
        if (existing.count <= 0) {
          held.delete(k);
          releaseFile(existing.file, existing.token);
        }
      },
    };
  }

  fs.mkdirSync(resolveLockDir(), { recursive: true });
  const file = lockPathFor(k);
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const started = Date.now();
  // 竞争痕迹：等到锁 / 抢占陈旧锁都说明在我们之外有别的持有者碰过这个目标，
  // 调用方据此作废「锁内重校验」用的缓存（见 import.mjs 的 freshIndexes）
  let contended = false;

  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, key: k, at: Date.now() }));
      fs.closeSync(fd);
      held.set(k, { count: 1, token, file });
      return {
        ok: true,
        file,
        token,
        contended,
        waitedMs: Date.now() - started,
        release() {
          const cur = held.get(k);
          if (!cur) return;
          cur.count--;
          if (cur.count <= 0) {
            held.delete(k);
            releaseFile(file, token);
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      contended = true;
      const info = readLock(file);
      const age = info?.at ? Date.now() - info.at : Number.POSITIVE_INFINITY;
      const holderDead = info?.pid ? !pidAlive(info.pid) : true;

      // 陈旧锁（持有者已退出或超时）→ 抢占
      if (age > staleMs || holderDead) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* 别人先删了 */
        }
        continue;
      }

      if (Date.now() - started >= timeoutMs) {
        return { ok: false, error: 'lock-timeout', file, holder: info, waitedMs: Date.now() - started, release() {} };
      }
      sleepSync(pollMs);
    }
  }
}

function releaseFile(file, token) {
  const info = readLock(file);
  // 只删自己的锁，避免误删被抢占后的新持有者
  if (info && info.token !== token) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export function lockDir() {
  return resolveLockDir();
}

// 诊断用：当前有哪些锁
export function listLocks() {
  const dir = resolveLockDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.lock'))
      .map((n) => {
        const info = readLock(path.join(dir, n));
        return info ? { ...info, alive: pidAlive(info.pid), file: n } : { file: n, unreadable: true };
      });
  } catch {
    return [];
  }
}
