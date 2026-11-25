// Runs the installed MiniMax scanner against synthetic and optional read-only real histories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { minimaxRevision, planMinimaxHistory, portableSummary, publishMinimaxHistory, readMinimaxHistory } from '../src/minimax-history.mjs';

const [archive, ...realHistories] = process.argv.slice(2);
if (!archive) throw new Error('usage: node test/probe-minimax-history.mjs <app.asar> [history-directory...]');
const fd = fs.openSync(archive, 'r');
const header = Buffer.alloc(16);
fs.readSync(fd, header, 0, header.length, 0);
const index = Buffer.alloc(header.readUInt32LE(12));
fs.readSync(fd, index, 0, index.length, 16);
const root = JSON.parse(index);
const offset = 8 + header.readUInt32LE(4);
const runtime = 'minimax-asar:/node_modules/@mavis/local-runtime-v2/dist/';
const harness = 'minimax-asar:/node_modules/@mavis/harness/dist/';
const harnessHistory = harness + 'engine/history/canonical/';
const harnessEntry = harness + 'session-sync-probe.js';
const archiveEntry = (name) => name.split('/').reduce((parent, part) => parent?.files?.[part], root);
const moduleAt = (...urls) => urls.find((url) => archiveEntry(new URL(url).pathname.slice(1)));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('minimax-asar:')) return { url: specifier, shortCircuit: true };
    if (context.parentURL?.startsWith('minimax-asar:') && specifier.startsWith('.')) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    }
    if (context.parentURL?.startsWith('minimax-asar:') && specifier === '@mavis/harness') {
      return { url: harnessEntry, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith('minimax-asar:')) return next(url, context);
    const name = new URL(url).pathname.slice(1);
    if (url === harnessEntry) {
      // Import the shipped history engine without starting unrelated AgentHost modules.
      const modules = ['archive-plan', 'canonical-record', 'generation-marker', 'history-lineage',
        'record-identity', 'turn-tail-mutation'];
      const source = modules.map((module) => 'export * from ' + JSON.stringify(harnessHistory + module + '.js') + ';').join('\n');
      return { format: 'module', source, shortCircuit: true };
    }
    if (url === harness + 'compaction/index.js') {
      return { format: 'module', source: "export * from './compat.js';", shortCircuit: true };
    }
    if (name.endsWith('/infra/logging/logger.js')) {
      return { format: 'module', source: 'export const logger = new Proxy({}, { get: () => () => {} });', shortCircuit: true };
    }
    if (name.endsWith('/ptc/safety-reconcile.js')) {
      // This probe has no tool execution. Fail if that unrelated dependency is reached.
      return { format: 'module', source: 'export function sanitizePtcSafetyHistoryMessage() { throw new Error("unexpected PTC safety mutation"); }', shortCircuit: true };
    }
    const entry = archiveEntry(name);
    if (!entry) throw new Error('missing installed MiniMax module: ' + name);
    if (entry.unpacked) {
      const source = fs.readFileSync(path.join(archive + '.unpacked', name), 'utf8');
      return { format: 'module', source, shortCircuit: true };
    }
    const source = Buffer.alloc(entry.size);
    fs.readSync(fd, source, 0, source.length, offset + Number(entry.offset));
    return { format: 'module', source, shortCircuit: true };
  },
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-minimax-oracle-'));
try {
  const { scanCanonicalHistoryArtifacts } = await import(runtime + 'service/session-system/messages/history/mutation/canonical-history-scanner.js');
  const { appendCompactionState, readCompactionCompatibility } = await import(moduleAt(
    runtime + 'service/turn-system/compaction/compat.js', harness + 'compaction/compat.js'));
  const { createCanonicalHistoryFileAdapter } = await import(runtime + 'service/session-system/sessions/representation/canonical-history.js');
  const { splitTurnStateLayers } = await import(moduleAt(
    runtime + 'service/turn-system/agent-host/execution/turn-state-layer/turn-layers.js',
    harness + 'agent-host/execution/turn-state-layer/turn-layers.js'));
  const historyModule = runtime + 'service/session-system/messages/history/';
  const { createSessionSystemCanonicalHistoryProvider } = await import(historyModule + 'canonical-history-provider.js');
  const { createSessionHistoryMutationAdapter } = await import(historyModule + 'mutation/session-history-mutation-adapter.js');
  const { readSegmentId, segmentPrefixDigest } = await import(historyModule + 'segment/segment-prefix.js');
  const { resolveSessionHistoryPaths } = await import(historyModule + 'session-history-paths.js');
  const scan = (location, sessionId) => scanCanonicalHistoryArtifacts({ sessionId,
    activePath: path.join(location, 'messages.jsonl'), snapshotsPath: path.join(location, 'snapshots') });
  const user = (i, text) => ({ message_id: 'msg-user-v1-probe-' + i, turn_id: 'probe-' + i,
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1792635493378 + i } });
  const groups = [user(0, 'covered'), user(1, 'first checkpoint'), user(2, 'middle'), user(3, 'second checkpoint'), user(4, 'tail')]
    .map((record, i) => ({ records: [record], ...(i % 2 ? { summary: record.message.content[0].text } : {}) }));
  const plan = planMinimaxHistory([], groups);
  publishMinimaxHistory(dir, null, plan);
  const { catalog, orphans } = await scan(dir, 'session-sync-probe');
  assert.equal(catalog.activeGeneration, 2);
  assert.deepEqual(catalog.artifacts.map((entry) => entry.messageCount), [1, 2, 2]);
  assert.deepEqual(orphans, []);
  assert.equal(catalog.activeRevision, minimaxRevision(plan.active));
  const active = await createCanonicalHistoryFileAdapter().readActiveStrict(path.join(dir, 'messages.jsonl'));
  const layers = splitTurnStateLayers({ history: active.map(({ message }) => message), systemPrompt: '', segmentPrefixLength: 1 });
  assert.equal(layers.handoffHeader.summary, 'second checkpoint');
  assert.deepEqual(layers.segmentConversation.map(({ content }) => content[0].text), ['tail']);

  const message = { role: 'compactionSummary', summary: appendCompactionState('handoff', { recentUserQueries: [{ text: 'synthetic' }] }) };
  assert.equal(portableSummary(message), readCompactionCompatibility(message).summary);
  console.log(JSON.stringify({ probe: 'synthetic', generation: catalog.activeGeneration, artifacts: catalog.artifacts.length, hostContinuationLayers: 'verified' }));

  const sessionId = 'session-sync-host-generated';
  const session = { sessionId, createdAtMs: 1792635493378 };
  const forked = { ...session, sessionId: sessionId + '-fork' };
  const options = { dataDir: dir, sessions: { get: (id) => id === sessionId ? session : id === forked.sessionId ? forked : undefined } };
  const paths = resolveSessionHistoryPaths(dir, session);
  const base = [user(10, 'covered once'), user(11, 'retained')];
  const files = createCanonicalHistoryFileAdapter();
  const provider = createSessionSystemCanonicalHistoryProvider(options);
  await provider.initialize(sessionId);
  await files.replaceActive(paths.messages, base);
  const compact = async (host, index) => {
    const current = await files.readActiveStrict(paths.messages);
    const retained = current.at(-1);
    return host.compact({ sessionId, turnId: 'checkpoint-' + index, compactionId: 'host-' + index,
      operation: { kind: 'compaction', id: 'checkpoint-' + index }, method: 'llm_segment_checkpoint',
      segmentExpectedId: readSegmentId(current), segmentCoveredCount: current.length - 1,
      segmentPrefixDigest: segmentPrefixDigest(current.slice(0, -1)), segmentSourceIndexes: [null, current.length - 1],
      messages: [{ role: 'compactionSummary', summary: 'host summary ' + index }, retained.message],
    });
  };
  assert.equal((await compact(provider, 1)).generation, 1);
  const restarted = createSessionSystemCanonicalHistoryProvider(options);
  const resumed = await restarted.readActive(sessionId);
  assert.deepEqual(resumed.messages.map((entry) => entry.summary ?? entry.content[0].text), ['host summary 1', 'retained']);
  assert.equal((await compact(restarted, 2)).generation, 2);
  const hostHistory = readMinimaxHistory(paths.sessionDir);
  assert.ifError(hostHistory.error);
  assert.deepEqual(hostHistory.records.map(({ message: entry }) => entry.summary ?? entry.content[0].text),
    ['covered once', 'retained', 'host summary 1', 'host summary 2']);
  const mutation = createSessionHistoryMutationAdapter(options);
  const beforeRewind = await mutation.read(sessionId);
  const fork = await mutation.stageFork({ sourceSessionId: sessionId, targetSessionId: forked.sessionId, operationId: 'fork-probe',
    generation: 2, active: beforeRewind.active, snapshots: beforeRewind.snapshots });
  await fork.publish();
  const forkPath = resolveSessionHistoryPaths(dir, forked).sessionDir;
  assert.deepEqual(readMinimaxHistory(forkPath).records, hostHistory.records);
  const rewind = await mutation.stageRewind({ sessionId, operationId: 'rewind-probe', expectedRevision: beforeRewind.revision,
    sourceGeneration: 2, generation: 0, active: base, snapshots: [] });
  await rewind.publish();
  assert.deepEqual(readMinimaxHistory(paths.sessionDir).records, base);
  assert.deepEqual(readMinimaxHistory(forkPath).records, hostHistory.records);
  console.log(JSON.stringify({ probe: 'host-generated', generation: 2, retainedExactlyOnce: true, providerReopened: true,
    forkPreserved: true, rewoundToGeneration: 0 }));

  for (const location of realHistories) {
    const observed = readMinimaxHistory(location);
    const { catalog: native } = await scan(location, 'read-only-probe');
    assert.ifError(observed.error);
    assert.equal(observed.revision, native.activeRevision);
    assert.equal(observed.generation, native.activeGeneration);
    for (const { message: summary } of observed.records.filter((row) => row.message.role === 'compactionSummary')) {
      assert.equal(portableSummary(summary), readCompactionCompatibility(summary).summary);
    }
    console.log(JSON.stringify({ probe: 'real-read-only', generation: native.activeGeneration, active: observed.active.length, recovered: observed.records.length }));
  }
} finally {
  hooks.deregister();
  fs.closeSync(fd);
  fs.rmSync(dir, { recursive: true, force: true });
}
