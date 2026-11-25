import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { minimaxRevision, publishMinimaxHistory, readMinimaxHistory } from './minimax-history.mjs';
import { writeSidecarProvenance } from './provenance.mjs';
import { tableColumns, tableExists } from './readers/base.mjs';
import { insertRowFiltered } from './writers/base.mjs';
import { sha256hex, writeFileAtomic } from './util.mjs';

const journalDir = (dbFile) => path.join(path.dirname(dbFile), 'session-sync-history-pending');
const journalFile = (dbFile, id) => path.join(journalDir(dbFile), sha256hex(String(id)) + '.json');
export const pendingMinimaxHistory = 'minimax-history-publication-pending';
const materializationTable = 'local_runtime_pi_history_file_migrations';
const materializationColumns = ['session_id', 'migrated_at_ms', 'source', 'message_count', 'target_revision'];
const snapshotPattern = /^g\d{12}--sync-([a-f0-9]{64})\.jsonl$/u;

export function hasMinimaxPublication(dbFile, id) {
  return fs.existsSync(journalFile(dbFile, id));
}

function revisionOf(bytes) {
  if (!bytes) return null;
  const records = bytes.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return minimaxRevision(records);
}

function readActive(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('minimax-invalid-active-file');
    return { bytes: fs.readFileSync(file), expectSize: stat.size, expectMtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { bytes: null, expectSize: -1 };
  }
}

function sessionDir(root, relativeDir) {
  if (typeof relativeDir !== 'string' || relativeDir.split('/').length !== 4 ||
      relativeDir.split('/').some((segment) => !segment || segment === '.' || segment === '..' || /[\\:]/u.test(segment))) {
    throw new Error('minimax-invalid-journal-directory');
  }
  const dir = path.join(root, relativeDir);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error('minimax-invalid-journal-directory');
  }
  return dir;
}

function materializationState(db, id) {
  if (!tableExists(db, materializationTable)) return 'unsupported';
  const columns = new Set(tableColumns(db, materializationTable));
  const missing = materializationColumns.filter((column) => !columns.has(column));
  if (missing.length) throw new Error('minimax-materialization-incompatible-schema: ' + missing.join(', '));
  return db.prepare('SELECT 1 FROM ' + materializationTable + ' WHERE session_id = ?').get(id) ? 'existing' : 'missing';
}

function committedHistory(db, id) {
  return tableExists(db, 'session_sync_history_commits')
    ? db.prepare('SELECT * FROM session_sync_history_commits WHERE session_id = ?').get(id)
    : undefined;
}

export function verifiedMinimaxImportPrefix(db, id, history) {
  const { revision, message_count: committedCount } = committedHistory(db, id) ?? {};
  if (!revision) return 0;
  if (history.revision === revision) return history.active.length;
  let count = committedCount;
  if (count == null && materializationState(db, id) === 'existing') {
    const checkpoint = db.prepare('SELECT message_count, target_revision FROM ' + materializationTable + ' WHERE session_id = ?').get(id);
    if (checkpoint.target_revision === revision) count = checkpoint.message_count;
  }
  if (!Number.isSafeInteger(count) || count <= 0 || count > history.active.length) return 0;
  return minimaxRevision(history.active.slice(0, count)) === revision ? count : 0;
}

export function registerMinimaxMaterialization(db, root, { id, relativeDir, revision, messageCount }) {
  if (materializationState(db, id) !== 'missing') return false;
  if (!db.isTransaction) throw new Error('minimax-materialization-requires-transaction');
  const dir = sessionDir(root, relativeDir);
  if (revisionOf(readActive(path.join(dir, 'messages.jsonl')).bytes) !== revision) {
    throw new Error('minimax-materialization-unverified-revision');
  }
  try {
    const inserted = insertRowFiltered(db, materializationTable, { session_id: id, migrated_at_ms: Date.now(),
      source: 'empty', message_count: messageCount, target_revision: revision });
    if (!inserted.inserted) throw new Error(inserted.error ?? 'no row inserted');
  } catch (error) {
    throw new Error('minimax-materialization-incompatible-schema: ' + error.message);
  }
  return true;
}

export function repairMinimaxMaterialization(db, root, { id, history, apply }) {
  const state = materializationState(db, id);
  if (state !== 'missing') return state;
  const row = db.prepare('SELECT workspace_dir, record_json, history_relative_dir FROM local_runtime_sessions WHERE session_id = ?').get(id);
  const workspace = row?.workspace_dir;
  if (!workspace?.trim() || JSON.parse(row.record_json)?.workspaceDir !== workspace ||
      !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('minimax-materialization-requires-workspace');
  }
  if (committedHistory(db, id)?.revision !== history.revision) throw new Error('minimax-materialization-unverified-revision');
  if (!apply) return state;
  return registerMinimaxMaterialization(db, root, { id, relativeDir: row.history_relative_dir,
    revision: history.revision, messageCount: history.active.length }) ? 'registered' : 'existing';
}

// The caller holds BEGIN IMMEDIATE until it commits the index and this marker together.
export function stageMinimaxPublication(db, dbFile, root, { id, relativeDir, expected, plan, provenance }) {
  const dir = sessionDir(root, relativeDir);
  const file = path.join(dir, 'messages.jsonl');
  const before = readActive(file).bytes;
  if (revisionOf(before) !== expected) throw new Error('minimax-history-revision-changed');
  const next = minimaxRevision(plan.active);
  if (next === expected) throw new Error('minimax-history-revision-unchanged');
  const token = randomUUID();
  const snapshots = plan.snapshots.filter(({ name }) => !fs.existsSync(path.join(dir, 'snapshots', name)))
    .map(({ name, revision }) => ({ name, revision }));
  const journal = { id, token, relativeDir, expected, next, backup: before?.toString('base64') ?? null,
    provenance: provenance ?? null, snapshots };
  writeFileAtomic(journalFile(dbFile, id), JSON.stringify(journal), { expectSize: -1 });
  publishMinimaxHistory(dir, expected, plan);
  const checked = readMinimaxHistory(dir);
  if (checked.error || revisionOf(readActive(file).bytes) !== next) {
    throw new Error('minimax-native-publication-verification-failed: ' + (checked.error ?? 'revision-changed'));
  }
  registerMinimaxMaterialization(db, root, { id, relativeDir, revision: next, messageCount: plan.active.length });
  db.exec('CREATE TABLE IF NOT EXISTS session_sync_history_commits (session_id TEXT PRIMARY KEY, token TEXT NOT NULL, revision TEXT NOT NULL, message_count INTEGER)');
  if (!tableColumns(db, 'session_sync_history_commits').includes('message_count')) {
    db.exec('ALTER TABLE session_sync_history_commits ADD COLUMN message_count INTEGER');
  }
  db.prepare('INSERT OR REPLACE INTO session_sync_history_commits (session_id, token, revision, message_count) VALUES (?, ?, ?, ?)')
    .run(id, token, next, plan.active.length);
  return next;
}

function settlePublication(db, root, journalPath) {
  if (!fs.lstatSync(journalPath).isFile()) throw new Error('minimax-invalid-publication-journal');
  const { id, token, relativeDir, expected, next, backup, provenance, snapshots = [] } = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (typeof id !== 'string' || typeof token !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(next) ||
      path.basename(journalPath) !== sha256hex(id) + '.json' || (backup !== null && typeof backup !== 'string')) {
    throw new Error('minimax-invalid-publication-journal');
  }
  const before = backup === null ? null : Buffer.from(backup, 'base64');
  if (revisionOf(before) !== expected || expected === next) throw new Error('minimax-invalid-publication-backup');
  const dir = sessionDir(root, relativeDir);
  const file = path.join(dir, 'messages.jsonl');
  const state = readActive(file);
  const revision = revisionOf(state.bytes);
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_sync_history_commits' AND type = 'table'").get();
  const marker = table && db.prepare('SELECT token, revision FROM session_sync_history_commits WHERE session_id = ?').get(id);
  const committed = marker?.token === token;
  if (committed) {
    if (marker.revision !== next || revision !== next || readMinimaxHistory(dir).error) {
      throw new Error('minimax-history-publication-conflict');
    }
    if (provenance) writeSidecarProvenance(file, provenance);
  } else if (revision === next) {
    if (before) writeFileAtomic(file, before, state);
    else {
      if (revisionOf(readActive(file).bytes) !== next) throw new Error('minimax-history-publication-conflict');
      fs.unlinkSync(file);
    }
  } else if (revision !== expected) {
    throw new Error('minimax-history-publication-conflict');
  }
  if (!committed) {
    for (const { name, revision: snapshotRevision } of snapshots) {
      const digest = snapshotPattern.exec(name)?.[1];
      if (!digest || snapshotRevision !== 'sha256:' + digest) continue;
      const snapshot = path.join(dir, 'snapshots', name);
      const state = readActive(snapshot);
      if (state.bytes && revisionOf(state.bytes) === snapshotRevision) fs.unlinkSync(snapshot);
    }
  }
  fs.unlinkSync(journalPath);
}

export function recoverMinimaxPublications(db, dbFile, root, id = null) {
  const dir = journalDir(dbFile);
  if (!fs.existsSync(dir)) return [];
  const recovered = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const files = id === null ? fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)) : [path.basename(journalFile(dbFile, id))];
    for (const name of files) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      settlePublication(db, root, file);
      recovered.push(name);
    }
    db.exec('COMMIT');
    return recovered;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
