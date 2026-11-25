import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { sessionCoreFingerprints } from '../src/ir.mjs';
import { readMinimaxHistory } from '../src/minimax-history.mjs';
import { readSession } from '../src/readers/index.mjs';
import { minimaxRecordTurns } from '../src/readers/minimax.mjs';
import { createMinimaxLiveProbe, minimaxLiveProbeFixture } from '../src/writers/minimax.mjs';

export function probeHistoryEvidence(source, history) {
  const original = sessionCoreFingerprints(source);
  const prefixLength = source.turns.reduce((count, turn) => count + turn.items.length, 0);
  const prefix = history.records.slice(0, prefixLength);
  const importedFingerprintsMatch = history.records.length >= prefixLength &&
    JSON.stringify(sessionCoreFingerprints({ turns: minimaxRecordTurns(prefix) })) === JSON.stringify(original);
  const replies = history.records.slice(prefixLength).flatMap(({ message }, offset) => {
    if (message.role !== 'assistant') return [];
    const text = (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    return [{ text, turn: minimaxRecordTurns(history.records.slice(0, prefixLength + offset + 1)).length }];
  });
  const markers = Object.fromEntries(source.turns.map(({ items }) => {
    const [, label, token] = /^The literal value of ([A-Z]+) is ([0-9a-f]+)\.$/u.exec(items[0].text);
    const active = history.active.filter(({ message }) => JSON.stringify(message).includes(token)).map(({ message }) => message.role);
    const matchingReplies = [...new Set(replies.filter(({ text }) => text.includes(token)).map(({ turn }) => turn))];
    return [label, { active, matchingReplies }];
  }));
  return { importedFingerprintsMatch, markers };
}

function main() {
  const [mode, suppliedNonce, ...extra] = process.argv.slice(2);
  if (extra.length || (mode === 'create' ? suppliedNonce != null : mode !== 'read' || !suppliedNonce)) {
    throw new Error('usage: node test/probe-minimax-live.mjs create | read <nonce>');
  }

  const nonce = suppliedNonce ?? randomBytes(6).toString('hex');
  const { session: source, targetId } = minimaxLiveProbeFixture(nonce);
  const home = os.homedir();
  const ctx = makeCtx({ home, env: { MINIMAX_HOME: path.join(home, '.minimax') } });
  if (mode === 'create') {
    const result = createMinimaxLiveProbe(ctx, nonce);
    assert.equal(result.ok, true, JSON.stringify({ nonce, ...result }));
  }

  const { session, error } = readSession('minimax', ctx, targetId);
  assert.ok(session && !session.meta.fileIncomplete, JSON.stringify({ nonce, targetId, error: error ?? session?.meta.historyError }));
  const history = readMinimaxHistory(session.meta.sourcePath);
  assert.ok(history.native && !history.error, history.error ?? 'missing native boundary');
  const { importedFingerprintsMatch, markers } = probeHistoryEvidence(source, history);
  const originMatches = session.origin?.variant === source.variant && session.origin?.sessionId === source.id &&
    session.chain?.some((hop) => hop.variant === source.variant && hop.sessionId === source.id);
  if (mode === 'create') {
    assert.equal(history.generation, 1);
    assert.ok(importedFingerprintsMatch && originMatches);
    assert.deepEqual(Object.values(markers).map(({ active }) => active), [[], ['compactionSummary'], ['user']]);
  }

  process.stdout.write(JSON.stringify({ nonce, targetId, title: session.title, historyDir: session.meta.sourcePath,
    generation: history.generation, activeRoles: history.active.map(({ message }) => message.role),
    turns: session.turns.length, summaries: session.turns.flatMap(({ items }) => items.filter((item) => item.compact)).length,
    importedFingerprintsMatch, originMatches, markers }, null, 2) + '\n');
}

if (import.meta.main) main();
