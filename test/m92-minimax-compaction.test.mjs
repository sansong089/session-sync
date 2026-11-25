import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeSession, makeTurn, messageItem, sessionCoreFingerprints } from '../src/ir.mjs';
import { executePlan, planImport } from '../src/import.mjs';
import { mintTargetId } from '../src/identity.mjs';
import { planMinimaxHistory, readMinimaxHistory, portableSummary, publishMinimaxHistory, minimaxRevision } from '../src/minimax-history.mjs';
import { hasMinimaxPublication, pendingMinimaxHistory, stageMinimaxPublication, verifiedMinimaxImportPrefix } from '../src/minimax-publication.mjs';
import { buildProvenance } from '../src/provenance.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { createMinimaxLiveProbe, minimaxLiveProbeFixture, upgradeMinimaxCompaction } from '../src/writers/minimax.mjs';
import { sandboxEnv, setupHome } from './matrix-home.mjs';
import { probeHistoryEvidence } from './probe-minimax-live.mjs';

const now = 1792635493378;
const user = (text, compact = false, response = null) => makeTurn('user', [messageItem('user', text, now, compact),
  ...(response ? [messageItem('assistant', response, now + 1)] : [])], now);
const checkpointFor = (db, id) => db.prepare('SELECT * FROM local_runtime_pi_history_file_migrations WHERE session_id = ?').get(id);

function fixture(t, native = true) {
  const { home, ctx } = setupHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (native) ctx.env.SESSION_SYNC_MINIMAX_NATIVE = '1';
  const id = mintTargetId('workbuddy-cn', 'minimax-native-history-test', now);
  const source = makeSession({ id, variant: 'workbuddy-cn', title: 'Portable history', cwd: home,
    createdAt: now, updatedAt: now + 1, turns: [user('repeat'), user('repeat'), user('checkpoint A', true, 'reply after A'),
      user('middle'), user('checkpoint B', true), user('latest')] });
  const writeSource = (session = source, mode = 'create', fromTurnIndex = 0) => {
    const result = getWriter('workbuddy-cn').write(ctx, { session, targetId: id, mode, fromTurnIndex });
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  const plan = (from, into, sourceId) => planImport(ctx, { from: [from], into: [into], ids: [sourceId] });
  const sync = (from, into, sourceId) => executePlan(ctx, plan(from, into, sourceId), { apply: true, lock: false })[0];
  const read = (variant, targetId) => readSession(variant, ctx, targetId).session;
  writeSource();
  const first = sync('workbuddy-cn', 'minimax', id);
  assert.equal(first.verify?.ok, true, JSON.stringify(first));
  const mmId = first.targetId;
  const dir = read('minimax', mmId).meta.sourcePath;
  return { ctx, id, source, writeSource, plan, sync, read, dir, mmId };
}

test('the MiniMax desktop probe refuses a non-default root without publishing its session', (t) => {
  const { ctx, read } = fixture(t);
  const nonce = '012345abcdef';
  assert.equal(createMinimaxLiveProbe(ctx, nonce).error, 'minimax-live-probe-requires-default-root');
  assert.equal(read('minimax', minimaxLiveProbeFixture(nonce).targetId), null);
});

test('probe and publication verification accept a host reply appended to the last imported turn', (t) => {
  const f = fixture(t);
  const { session, targetId } = minimaxLiveProbeFixture('012345abcdef', now);
  const writer = getWriter('minimax');
  assert.equal(writer.write(f.ctx, { session, targetId, mode: 'create', provenance: buildProvenance(session) }).ok, true);
  const dir = f.read('minimax', targetId).meta.sourcePath;
  const file = path.join(dir, 'messages.jsonl');
  const { active } = readMinimaxHistory(dir);
  const reply = { message_id: 'msg-first-reply', turn_id: active.at(-1).turn_id,
    message: { role: 'assistant', content: [{ type: 'text', text: session.turns.at(-1).items[0].text }], timestamp: now + 10, provider: 'native' } };
  fs.appendFileSync(file, JSON.stringify(reply) + '\n');
  const evidence = probeHistoryEvidence(session, readMinimaxHistory(dir));
  assert.equal(evidence.importedFingerprintsMatch, true);
  assert.deepEqual(evidence.markers.TAIL.matchingReplies, [3]);

  const base = f.read('minimax', targetId);
  const longer = { ...base, turns: [...base.turns, user('session-sync append')] };
  assert.equal(writer.write(f.ctx, { session: longer, targetId, mode: 'append', fromTurnIndex: base.turns.length,
    provenance: buildProvenance(session) }).ok, true);
  const committed = readMinimaxHistory(dir);
  fs.appendFileSync(file, JSON.stringify({ ...reply, message_id: 'msg-second-reply' }) + '\n');
  const db = new DatabaseSync(path.join(f.ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
  try {
    assert.notEqual(checkpointFor(db, targetId).target_revision, committed.revision);
    assert.equal(verifiedMinimaxImportPrefix(db, targetId, readMinimaxHistory(dir)), committed.active.length);
  } finally { db.close(); }
});

for (const native of [false, true]) {
  test('MiniMax registers the active file for a ' + (native ? 'native' : 'tagged') + ' import', (t) => {
    const { ctx, dir, mmId } = fixture(t, native);
    const db = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
    try {
      const active = readMinimaxHistory(dir).active;
      const checkpoint = checkpointFor(db, mmId);
      assert.equal(checkpoint?.source, 'empty');
      assert.equal(checkpoint.message_count, active.length);
      assert.equal(checkpoint.target_revision, minimaxRevision(active));
      const assistants = readMinimaxHistory(dir).records.filter(({ message }) => message.role === 'assistant');
      assert.ok(assistants.length);
      assert.ok(assistants.every(({ message }) => message.provider === 'session-sync'));
    } finally {
      db.close();
    }
  });
}

test('a previous native import can register verified history without rewriting any files', (t) => {
  const { ctx, dir, mmId, read } = fixture(t);
  const db = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
  try {
    db.prepare('DELETE FROM local_runtime_pi_history_file_migrations WHERE session_id = ?').run(mmId);
  } finally {
    db.close();
  }
  const checkpoint = () => {
    const reader = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'), { readOnly: true });
    try { return checkpointFor(reader, mmId); }
    finally { reader.close(); }
  };
  delete ctx.env.SESSION_SYNC_MINIMAX_NATIVE;
  const before = readMinimaxHistory(dir);
  const session = read('minimax', mmId);
  assert.equal(upgradeMinimaxCompaction(ctx, mmId).checkpoint, 'missing');
  assert.equal(checkpoint(), undefined);
  const activeFile = path.join(dir, 'messages.jsonl');
  const bytes = fs.readFileSync(activeFile);
  fs.appendFileSync(activeFile, JSON.stringify({ message_id: 'msg-concurrent', turn_id: 'concurrent',
    message: { role: 'user', timestamp: now, content: [{ type: 'text', text: 'external change' }] } }) + '\n');
  assert.equal(upgradeMinimaxCompaction(ctx, mmId, { apply: true }).error, 'minimax-materialization-unverified-revision');
  assert.equal(checkpoint(), undefined);
  fs.writeFileSync(activeFile, bytes);
  assert.equal(upgradeMinimaxCompaction(ctx, mmId, { apply: true }).checkpoint, 'registered');
  assert.equal(checkpoint()?.target_revision, before.revision);
  assert.equal(upgradeMinimaxCompaction(ctx, mmId, { apply: true }).reason, 'already-native');
  assert.deepEqual(readMinimaxHistory(dir), before);
  assert.deepEqual(fs.readFileSync(activeFile), bytes);
  const repaired = read('minimax', mmId);
  assert.deepEqual(repaired.origin, session.origin);
  assert.deepEqual(sessionCoreFingerprints(repaired), sessionCoreFingerprints(session));
});

test('native repair fills the imported assistant provider and respects a host-appended tail', (t) => {
  const { ctx, read } = fixture(t);
  const { session: source, targetId } = minimaxLiveProbeFixture('012345abcdef', now);
  const result = getWriter('minimax').write(ctx, { session: source, targetId, mode: 'create', provenance: buildProvenance(source) });
  assert.equal(result.ok, true, JSON.stringify(result));
  const dir = read('minimax', targetId).meta.sourcePath;
  const { active } = readMinimaxHistory(dir);
  const assistant = active.find(({ message }) => message.role === 'assistant');
  assert.equal(assistant.message.provider, 'session-sync');
  delete assistant.message.provider;
  const oldRevision = minimaxRevision(active);
  const hostTail = { message_id: 'msg-assistant-v1-host-tail', turn_id: 'host-tail',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Native reply' }], timestamp: now + 10, provider: 'native' } };
  const file = path.join(dir, 'messages.jsonl');
  fs.writeFileSync(file, [...active, hostTail].map((row) => JSON.stringify(row) + '\n').join(''));
  const db = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
  try {
    db.prepare('UPDATE session_sync_history_commits SET revision = ? WHERE session_id = ?').run(oldRevision, targetId);
    db.prepare('UPDATE local_runtime_pi_history_file_migrations SET target_revision = ? WHERE session_id = ?').run(oldRevision, targetId);
    const checkpoint = checkpointFor(db, targetId);
    const before = read('minimax', targetId);
    const snapshots = path.join(dir, 'snapshots');
    const snapshot = path.join(snapshots, fs.readdirSync(snapshots)[0]);
    const snapshotBytes = fs.readFileSync(snapshot);
    delete ctx.env.SESSION_SYNC_MINIMAX_NATIVE;
    assert.equal(upgradeMinimaxCompaction(ctx, targetId).assistantProviderMissing, 1);
    assert.equal(readMinimaxHistory(dir).active.at(-2).message.provider, undefined);
    const unchanged = fs.readFileSync(file);
    assert.equal(upgradeMinimaxCompaction(ctx, targetId, { apply: true }).error, 'minimax-native-history-write-unverified');
    assert.deepEqual(fs.readFileSync(file), unchanged);
    ctx.env.SESSION_SYNC_MINIMAX_NATIVE = '1';
    assert.equal(upgradeMinimaxCompaction(ctx, targetId, { apply: true }).assistantProviderRepaired, 1);
    assert.equal(readMinimaxHistory(dir).active.at(-2).message.provider, 'session-sync');
    assert.deepEqual(readMinimaxHistory(dir).active.at(-1), hostTail);
    assert.deepEqual(fs.readFileSync(snapshot), snapshotBytes);
    assert.deepEqual(checkpointFor(db, targetId), checkpoint);
    assert.deepEqual(sessionCoreFingerprints(read('minimax', targetId)), sessionCoreFingerprints(before));
    assert.deepEqual(read('minimax', targetId).origin, before.origin);
    assert.equal(upgradeMinimaxCompaction(ctx, targetId, { apply: true }).reason, 'already-native');
  } finally {
    db.close();
  }
});

test('a default MiniMax import has a runtime workspace and can repair a blank workspace without changing history', (t) => {
  const { ctx, read } = fixture(t);
  const { session, targetId } = minimaxLiveProbeFixture('012345abcdef', now);
  const writer = getWriter('minimax');
  const result = writer.write(ctx, { session, targetId, mode: 'create', provenance: buildProvenance(session) });
  assert.equal(result.ok, true, JSON.stringify(result));
  const dir = read('minimax', targetId).meta.sourcePath;
  const workspace = path.join(ctx.env.MINIMAX_HOME, 'sessions', targetId, 'workspace');
  const db = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const get = () => db.prepare('SELECT * FROM local_runtime_sessions WHERE session_id = ?').get(targetId);
  const assertWorkspace = (row) => {
    assert.equal(row.workspace_dir, workspace);
    assert.equal(row.project_workspace_dir, workspace);
    assert.equal(JSON.parse(row.record_json).workspaceDir, workspace);
    assert.equal(row.is_default_workspace, 1);
    assert.equal(db.prepare('SELECT project_kind FROM local_runtime_projects WHERE project_id = ?').get(row.project_id).project_kind, 'default');
  };
  try {
    assertWorkspace(get());
    assert.ok(fs.statSync(workspace).isDirectory());
    const before = readMinimaxHistory(dir);
    const record = { ...JSON.parse(get().record_json), workspaceDir: '' };
    db.prepare("UPDATE local_runtime_sessions SET workspace_dir = '', project_workspace_dir = NULL, record_json = ?, extra_data_json = '{}' WHERE session_id = ?")
      .run(JSON.stringify(record), targetId);
    assert.equal(writer.ensureIndex(ctx, { targetId }).changed, true);
    assertWorkspace(get());
    assert.equal(writer.ensureIndex(ctx, { targetId }).changed, false);
    assert.deepEqual(readMinimaxHistory(dir), before);
    assert.deepEqual(sessionCoreFingerprints(read('minimax', targetId)), sessionCoreFingerprints(session));
  } finally {
    db.close();
  }
});

test('native MiniMax create, append and next-hop round-trip preserve fingerprints and provenance', (t) => {
  const { ctx, id, source, writeSource, plan, sync, read, dir, mmId } = fixture(t);
  const history = readMinimaxHistory(dir);
  assert.equal(history.generation, 2);
  assert.deepEqual(history.active.map(({ message }) => message.summary ?? message.content[0].text), ['checkpoint B', 'latest']);
  assert.deepEqual(sessionCoreFingerprints(read('minimax', mmId)), sessionCoreFingerprints(source));
  assert.equal(listSessions('minimax', ctx).sessions.find((s) => s.id === mmId).turns, source.turns.length);

  for (const target of ['codex', 'opencode']) {
    const result = sync('minimax', target, mmId);
    assert.equal(result.verify?.ok, true, JSON.stringify(result));
    const copy = read(target, result.targetId);
    assert.deepEqual(sessionCoreFingerprints(copy), sessionCoreFingerprints(source));
    assert.equal(copy.turns.flatMap((turn) => turn.items.filter((item) => item.compact)).length, 2);
    assert.deepEqual(copy.origin, { variant: 'workbuddy-cn', sessionId: id });
    assert.equal(result.targetId, plan('workbuddy-cn', target, id).pairs[0].targetId);
  }

  const db = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const initialCheckpoint = checkpointFor(db, mmId);
  db.prepare("UPDATE local_runtime_sessions SET extra_data_json = '{}' WHERE session_id = ?").run(mmId);
  db.close();
  assert.deepEqual(read('minimax', mmId).origin, { variant: 'workbuddy-cn', sessionId: id });
  assert.equal(plan('workbuddy-cn', 'minimax', id).pairs[0].action, 'skip');
  assert.deepEqual(getWriter('minimax').repair(ctx).repaired, []);

  const tail = user('ordinary continuation');
  writeSource({ ...source, turns: [...source.turns, tail] }, 'append', source.turns.length);
  const ordinary = sync('workbuddy-cn', 'minimax', id);
  assert.equal(ordinary.verify?.ok, true, JSON.stringify(ordinary));
  assert.equal(readMinimaxHistory(dir).generation, 2);
  const third = { ...source, turns: [...source.turns, tail, user('checkpoint C', true), user('new continuation')] };
  writeSource(third, 'append', source.turns.length + 1);
  const append = sync('workbuddy-cn', 'minimax', id);
  assert.equal(append.verify?.ok, true, JSON.stringify(append));
  assert.equal(append.targetId, mmId);
  assert.equal(readMinimaxHistory(dir).generation, 3);
  const reopened = new DatabaseSync(path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'), { readOnly: true });
  try { assert.deepEqual(checkpointFor(reopened, mmId), initialCheckpoint); }
  finally { reopened.close(); }
  assert.equal(plan('workbuddy-cn', 'minimax', id).pairs[0].action, 'skip');
  assert.deepEqual(sessionCoreFingerprints(read('minimax', mmId)), sessionCoreFingerprints(third));
});

test('missing native parent is visible but blocked in planning and repair', (t) => {
  const { ctx, plan, read, dir, mmId } = fixture(t);
  const files = fs.readdirSync(path.join(dir, 'snapshots'));
  fs.unlinkSync(path.join(dir, 'snapshots', files[0]));
  assert.equal(read('minimax', mmId).meta.historyError, 'parent-snapshot-missing');
  assert.equal(plan('minimax', 'codex', mmId).pairs[0].reason, 'source-history-incomplete');
  assert.deepEqual(getWriter('minimax').repair(ctx).repaired, []);
});

test('missing native active file cannot fall back to its SQLite projection', (t) => {
  const { ctx, id, source, plan, read, dir, mmId } = fixture(t);
  fs.unlinkSync(path.join(dir, 'messages.jsonl'));
  assert.equal(read('minimax', mmId).meta.historyError, 'active-history-missing');
  assert.equal(plan('minimax', 'codex', mmId).pairs[0].reason, 'source-history-incomplete');
  assert.equal(plan('workbuddy-cn', 'minimax', id).pairs[0].reason, 'target-unreadable');
  assert.match(getWriter('minimax').write(ctx, { session: source, targetId: mmId, mode: 'append' }).error, /active-history-missing/u);
  assert.deepEqual(getWriter('minimax').repair(ctx).repaired, []);
});

test('empty or damaged active history without a catalog remains a source read error', (t) => {
  const { ctx, id, dir, mmId, plan, read } = fixture(t);
  const file = path.join(dir, 'messages.jsonl');
  const tail = fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(1).join('\n');
  for (const bytes of ['', '{broken header\n' + tail]) {
    fs.writeFileSync(file, bytes);
    assert.equal(read('minimax', mmId).meta.storage, 'v2-files');
    const result = plan('minimax', 'codex', mmId);
    assert.equal(result.pairs[0].reason, 'source-history-incomplete');
    assert.deepEqual(result.errors, [{ variant: 'minimax', id: mmId, phase: 'read-source', error: 'active-history-boundary-missing' }]);
    assert.equal(plan('workbuddy-cn', 'minimax', id).pairs[0].reason, 'target-unreadable');
  }
  const args = [path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs'), 'status', '--from', 'minimax', '--into', 'codex', '--id', mmId];
  const options = { env: sandboxEnv(ctx.home, { MINIMAX_HOME: ctx.env.MINIMAX_HOME, APPDATA: ctx.appData, LOCALAPPDATA: ctx.localAppData }), encoding: 'utf8' };
  const json = spawnSync(process.execPath, [...args, '--json'], options);
  assert.equal(json.status, 1, json.stdout + json.stderr);
  assert.equal(JSON.parse(json.stdout).ok, false);
  const plain = spawnSync(process.execPath, args, options);
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /active-history-boundary-missing/u);
});

test('MiniMax reports an incompatible materialization schema without committing an import', (t) => {
  const f = fixture(t);
  const targetId = mintTargetId('minimax', 'incompatible-materialization', now);
  const db = new DatabaseSync(path.join(f.ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite'));
  try {
    db.exec('ALTER TABLE local_runtime_pi_history_file_migrations DROP COLUMN target_revision');
    const result = getWriter('minimax').write(f.ctx, { session: f.source, targetId, mode: 'create', provenance: buildProvenance(f.source) });
    assert.match(result.error, /minimax-materialization-incompatible-schema: target_revision/u);
    assert.equal(f.read('minimax', targetId), null);
  } finally { db.close(); }
});

test('a damaged same-origin sibling does not block a healthy exact match', (t) => {
  const f = fixture(t);
  const targetId = mintTargetId('minimax', 'damaged-sibling', now);
  const written = getWriter('minimax').write(f.ctx, { session: f.source, targetId, mode: 'create', provenance: buildProvenance(f.source) });
  assert.equal(written.ok, true, JSON.stringify(written));
  const snapshots = path.join(f.read('minimax', targetId).meta.sourcePath, 'snapshots');
  fs.unlinkSync(path.join(snapshots, fs.readdirSync(snapshots)[0]));
  const result = f.sync('workbuddy-cn', 'minimax', f.id);
  assert.equal(result.action, 'skip');
  assert.equal(result.targetId, f.mmId);
  assert.equal(f.read('minimax', targetId).meta.historyError, 'parent-snapshot-missing');
});

test('legacy repair uses turn order even when a missing turn predates its anchor', (t) => {
  const f = fixture(t, false);
  const source = { ...f.source, id: 'ts-order', turns: [user('first'), { ...user('second'), startedAt: now - 10 }] };
  const targetId = mintTargetId('minimax', 'ts-order', now);
  const writer = getWriter('minimax');
  assert.equal(writer.write(f.ctx, { session: source, targetId, mode: 'create', provenance: buildProvenance(source) }).ok, true);
  const file = path.join(f.read('minimax', targetId).meta.sourcePath, 'messages.jsonl');
  const [first, second] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, first.replace(String(now), String(now + 100)) + '\n');
  assert.deepEqual(writer.repair(f.ctx).repaired, [targetId]);
  assert.deepEqual(sessionCoreFingerprints(f.read('minimax', targetId)), sessionCoreFingerprints(source));
  assert.deepEqual(writer.repair(f.ctx).repaired, []);
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 2);
  const misordered = second + '\n' + first + '\n';
  fs.writeFileSync(file, misordered);
  assert.ok(writer.repair(f.ctx).warnings.includes('canonical-history-repair-ambiguous: ' + targetId));
  assert.equal(fs.readFileSync(file, 'utf8'), misordered);
});

test('explicit repair upgrades old labels in place and retains the complete core sequence', (t) => {
  const { ctx, source, read, dir, mmId } = fixture(t, false);
  assert.equal(readMinimaxHistory(dir).native, false);
  assert.equal(upgradeMinimaxCompaction(ctx, mmId).boundaries, 2);
  assert.equal(upgradeMinimaxCompaction(ctx, mmId, { apply: true }).error, 'minimax-native-history-write-unverified');
  ctx.env.SESSION_SYNC_MINIMAX_NATIVE = '1';
  const result = upgradeMinimaxCompaction(ctx, mmId, { apply: true });
  assert.equal(result.upgraded, 2, JSON.stringify(result));
  assert.equal(upgradeMinimaxCompaction(ctx, mmId, { apply: true }).reason, 'already-native');
  assert.deepEqual(sessionCoreFingerprints(read('minimax', mmId)), sessionCoreFingerprints(source));
});

test('semantic revision rejects concurrent publications and valid appendices are stripped', (t) => {
  const { dir } = fixture(t);
  const original = readMinimaxHistory(dir);
  assert.throws(() => publishMinimaxHistory(dir, minimaxRevision([]), { snapshots: [], active: [] }), /revision-changed/u);
  assert.equal(readMinimaxHistory(dir).revision, original.revision);
  const summary = 'handoff\n\n<mavis-context-appendix version="5">\n## Recent user queries\n_None_\n</mavis-context-appendix>';
  assert.equal(portableSummary({ role: 'compactionSummary', summary }), 'handoff');
  const malformed = summary.replace('_None_', 'ordinary text');
  assert.equal(portableSummary({ role: 'compactionSummary', summary: malformed }), malformed);
});

function interruptPublication({ ctx, dir, mmId }, { committed = false } = {}) {
  const root = path.join(ctx.env.MINIMAX_HOME, 'v2', 'sessions');
  const dbFile = path.join(ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite');
  const history = readMinimaxHistory(dir);
  const active = [...history.active, { message_id: 'msg-recovery-tail', turn_id: 'recovery-tail',
    message: { role: 'user', content: [{ type: 'text', text: 'Committed tail' }], timestamp: now + 10 } }];
  const db = new DatabaseSync(dbFile);
  db.prepare('DELETE FROM local_runtime_pi_history_file_migrations WHERE session_id = ?').run(mmId);
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE local_runtime_sessions SET title = 'Updated by publication' WHERE session_id = ?").run(mmId);
  const next = stageMinimaxPublication(db, dbFile, root, { id: mmId, relativeDir: path.relative(root, dir).split(path.sep).join('/'),
    expected: history.revision, plan: { active, snapshots: [] } });
  if (committed) db.exec('COMMIT');
  db.close();
  return { dbFile, before: history.revision, next };
}

test('interrupted append rolls back before commit, including an import retry', (t) => {
  const f = fixture(t);
  const { before, dbFile } = interruptPublication(f);
  assert.equal(f.read('minimax', f.mmId).meta.historyError, pendingMinimaxHistory);
  assert.equal(f.plan('workbuddy-cn', 'minimax', f.id).pairs[0].error, pendingMinimaxHistory);
  const both = planImport(f.ctx, { from: ['workbuddy-cn', 'minimax'], into: ['codex'] });
  assert.equal(both.sourceDuplicates.length, 0);
  assert.equal(both.pairs.find((pair) => pair.sourceVariant === 'minimax').reason, 'source-history-incomplete');
  delete f.ctx.env.SESSION_SYNC_MINIMAX_NATIVE;
  assert.equal(upgradeMinimaxCompaction(f.ctx, f.mmId, { apply: true }).error, 'minimax-native-history-write-unverified');
  assert.equal(hasMinimaxPublication(dbFile, f.mmId), true);
  f.ctx.env.SESSION_SYNC_MINIMAX_NATIVE = '1';
  const result = f.sync('workbuddy-cn', 'minimax', f.id);
  assert.equal(result.action, 'skip', JSON.stringify(result));
  assert.equal(hasMinimaxPublication(dbFile, f.mmId), false);
  assert.equal(readMinimaxHistory(f.dir).revision, before);
  assert.equal(f.read('minimax', f.mmId).title, 'Portable history');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { assert.equal(checkpointFor(db, f.mmId), undefined); }
  finally { db.close(); }
});

test('interrupted committed append keeps the new history and index', (t) => {
  const f = fixture(t);
  const { dbFile, next } = interruptPublication(f, { committed: true });
  assert.equal(f.read('minimax', f.mmId).meta.historyError, pendingMinimaxHistory);
  assert.equal(upgradeMinimaxCompaction(f.ctx, f.mmId, { apply: true }).reason, 'already-native');
  assert.equal(hasMinimaxPublication(dbFile, f.mmId), false);
  assert.equal(readMinimaxHistory(f.dir).revision, next);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { assert.equal(checkpointFor(db, f.mmId)?.target_revision, next); }
  finally { db.close(); }
  const session = f.read('minimax', f.mmId);
  assert.equal(session.turns.length, f.source.turns.length + 1);
  assert.equal(session.title, 'Updated by publication');
});

test('rollback of the first native boundary does not leave legacy history looking damaged', (t) => {
  const f = fixture(t, false);
  f.ctx.env.SESSION_SYNC_MINIMAX_NATIVE = '1';
  const root = path.join(f.ctx.env.MINIMAX_HOME, 'v2', 'sessions');
  const dbFile = path.join(f.ctx.env.MINIMAX_HOME, 'v2', 'sqlite', 'runtime-state.sqlite');
  const history = readMinimaxHistory(f.dir);
  const summary = 'new native boundary';
  const plan = planMinimaxHistory(history.active, [{ summary, records: [{ message_id: 'msg-native-boundary', turn_id: 'native-boundary',
    message: { role: 'user', content: [{ type: 'text', text: summary }], timestamp: now + 10 } }] }]);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('BEGIN IMMEDIATE');
    stageMinimaxPublication(db, dbFile, root, { id: f.mmId, relativeDir: path.relative(root, f.dir).split(path.sep).join('/'),
      expected: minimaxRevision(history.active), plan });
    db.exec('ROLLBACK');
  } finally { db.close(); }
  assert.equal(readMinimaxHistory(f.dir).native, true);
  assert.equal(getWriter('minimax').repair(f.ctx).ok, true);
  assert.deepEqual(readMinimaxHistory(f.dir), history);
  assert.equal(hasMinimaxPublication(dbFile, f.mmId), false);
});

test('a third active revision does not get overwritten during recovery', (t) => {
  const f = fixture(t);
  const { dbFile } = interruptPublication(f);
  const file = path.join(f.dir, 'messages.jsonl');
  const message = { message_id: 'msg-foreign-tail', turn_id: 'foreign-tail',
    message: { role: 'user', content: [{ type: 'text', text: 'Foreign update' }], timestamp: now + 11 } };
  fs.appendFileSync(file, JSON.stringify(message) + '\n');
  const changed = fs.readFileSync(file, 'utf8');
  assert.equal(upgradeMinimaxCompaction(f.ctx, f.mmId, { apply: true }).error, 'minimax-history-publication-conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.equal(hasMinimaxPublication(dbFile, f.mmId), true);
});

test('a native parent broken after planning cannot be treated as a skip', (t) => {
  const f = fixture(t);
  const planned = f.plan('workbuddy-cn', 'minimax', f.id);
  assert.equal(planned.pairs[0].action, 'skip');
  const snapshots = path.join(f.dir, 'snapshots');
  fs.unlinkSync(path.join(snapshots, fs.readdirSync(snapshots)[0]));
  const result = executePlan(f.ctx, planned, { apply: true, lock: false })[0];
  assert.equal(result.action, 'error');
  assert.equal(result.error, 'parent-snapshot-missing');
});
