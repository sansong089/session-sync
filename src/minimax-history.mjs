import fs from 'node:fs';
import path from 'node:path';
import { sha256hex, stableStringify, writeFileAtomic } from './util.mjs';

const digest = /^sha256:[a-f0-9]{64}$/u;
const snapshotId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function minimaxRevision(records) {
  const sort = (value) => Array.isArray(value) ? value.map(sort) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  return 'sha256:' + sha256hex(JSON.stringify(records.map(sort)));
}

export function snapshotName(generation, id) {
  return 'g' + String(generation).padStart(12, '0') + '--' + id + '.jsonl';
}

const jsonl = (records) => records.map((record) => JSON.stringify(record) + '\n').join('');
export const missingToolReceipt = 'session-sync-missing-tool-receipt';

function pairToolRecords(records) {
  const results = new Map();
  for (const record of records) {
    if (record.message.role !== 'toolResult') continue;
    const id = record.message.toolCallId;
    if (results.has(id)) throw new Error('duplicate-tool-receipt');
    results.set(id, record);
  }
  const output = [];
  for (const record of records) {
    const { message } = record;
    if (message.role === 'toolResult') continue;
    output.push(record);
    if (message.role !== 'assistant') continue;
    for (const call of message.content.filter((block) => block.type === 'toolCall')) {
      const supplied = results.get(call.id);
      if (supplied) {
        results.delete(call.id);
        output.push(supplied);
      } else {
        output.push({
          message_id: 'msg-toolResult-v1-' + sha256hex(record.message_id + ':' + call.id),
          turn_id: record.turn_id,
          message: {
            role: 'toolResult', toolCallId: call.id, toolName: call.name, timestamp: message.timestamp,
            isError: true, content: [{ type: 'text', text: 'The source session does not contain a result for this tool call.' }],
            details: { [missingToolReceipt]: true },
          },
        });
      }
    }
  }
  if (results.size) throw new Error('orphan-tool-receipt');
  return output;
}

export function planMinimaxHistory(active, groups) {
  let generation = lineage(active).generation;
  let next = [...active];
  const snapshots = [];
  for (const group of groups) {
    const records = pairToolRecords(group.records);
    if (group.summary === undefined) {
      next.push(...records);
      continue;
    }
    const revision = minimaxRevision(next);
    const compactionId = 'sync-' + revision.slice(7);
    snapshots.push({ name: snapshotName(generation, compactionId), records: next, revision });
    next = [{
      message_id: 'msg-compaction-v1-' + sha256hex(group.records[0].message_id),
      turn_id: group.records[0].turn_id + ':compaction',
      message: { role: 'compactionSummary', summary: group.summary },
      history_artifact: {
        schemaVersion: 1, generation: generation + 1, producedBy: 'llm_checkpoint',
        parentSnapshot: { generation, compactionId, revision },
      },
    }, ...records.slice(1)];
    generation++;
  }
  for (const segment of [...snapshots.map((snapshot) => snapshot.records), next]) {
    validateSegment(segment);
    validateToolSequence(segment);
  }
  return { snapshots, active: next };
}

function validateToolSequence(records) {
  const seen = new Set();
  const pending = new Set();
  for (const { message } of records) {
    if (message.role === 'toolResult') {
      if (!pending.delete(message.toolCallId)) throw new Error('out-of-order-tool-receipt');
      continue;
    }
    if (pending.size) throw new Error('unsettled-tool-call');
    if (message.role !== 'assistant') continue;
    for (const call of message.content.filter((block) => block.type === 'toolCall')) {
      if (typeof call.id !== 'string' || !call.id.trim() || seen.has(call.id)) throw new Error('invalid-tool-call-id');
      seen.add(call.id);
      pending.add(call.id);
    }
  }
  if (pending.size) throw new Error('unsettled-tool-call');
}

export function publishMinimaxHistory(dir, expected, plan) {
  const file = path.join(dir, 'messages.jsonl');
  const found = fs.existsSync(file) ? fs.statSync(file) : null;
  if ((found ? minimaxRevision(parse(fs.readFileSync(file, 'utf8'))) : null) !== expected) {
    throw new Error('minimax-history-revision-changed');
  }
  for (const snapshot of plan.snapshots) {
    const target = path.join(dir, 'snapshots', snapshot.name);
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile() || minimaxRevision(parse(fs.readFileSync(target, 'utf8'))) !== snapshot.revision) {
        throw new Error('minimax-snapshot-conflict');
      }
    } else {
      writeFileAtomic(target, jsonl(snapshot.records), { expectSize: -1 });
    }
  }
  writeFileAtomic(file, jsonl(plan.active), { expectSize: found?.size ?? -1, expectMtimeMs: found?.mtimeMs });
  return minimaxRevision(plan.active);
}

const boundary = (message) => message?.role === 'compactionSummary' || Object.hasOwn(message ?? {}, 'archonCompaction');

function validateSegment(records) {
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    if (!object(record) || typeof record.message_id !== 'string' || !/^(?:msg-.+|\d+)$/u.test(record.message_id) ||
        typeof record.turn_id !== 'string' || !record.turn_id.trim() || !object(record.message) ||
        typeof record.message.role !== 'string' || !record.message.role || ids.has(record.message_id)) {
      throw new Error('invalid-history-envelope');
    }
    ids.add(record.message_id);
    if (index && (Object.hasOwn(record, 'history_artifact') || boundary(record.message))) {
      throw new Error('misplaced-compaction-boundary');
    }
    const { message } = record;
    if (message.role === 'compactionSummary') {
      const { summary, timestamp, tokensBefore } = message;
      const full = Object.hasOwn(message, 'timestamp') || Object.hasOwn(message, 'tokensBefore');
      if (typeof summary !== 'string' || (full ? !Number.isFinite(timestamp) ||
          !Number.isSafeInteger(tokensBefore) || tokensBefore < 0 : Object.keys(message).length !== 2)) {
        throw new Error('invalid-compaction-summary');
      }
    } else if (!Number.isFinite(message.timestamp)) {
      throw new Error('invalid-history-timestamp');
    }
  }
}

function lineage(records) {
  const first = records[0];
  const marker = first?.history_artifact;
  const legacy = first?.message?.archonCompaction;
  if (legacy !== undefined && portableSummary(first.message) === null) throw new Error('invalid-legacy-compaction');
  if (marker === undefined && legacy?.schemaVersion !== 2) return { generation: 0 };
  const { generation, parentSnapshot } = marker ?? legacy ?? {};
  if ((marker !== undefined && (marker?.schemaVersion !== 1 || Object.keys(marker).length !== 4 ||
      !['tool_archive', 'tool_trim', 'llm_checkpoint'].includes(marker.producedBy))) ||
      !Number.isSafeInteger(generation) || generation < 1 || !object(parentSnapshot) ||
      Object.keys(parentSnapshot).length !== 3 || parentSnapshot.generation !== generation - 1 ||
      typeof parentSnapshot.compactionId !== 'string' || !snapshotId.test(parentSnapshot.compactionId) ||
      typeof parentSnapshot.revision !== 'string' || !digest.test(parentSnapshot.revision)) {
    throw new Error('invalid-generation-marker');
  }
  return { generation, parentSnapshot };
}

function stitch(segments) {
  const seen = new Map();
  const records = [];
  for (const [generation, segment] of segments.entries()) {
    let previous = -1;
    for (const [position, record] of segment.entries()) {
      const { history_artifact: _, ...payload } = record;
      const identity = stableStringify(payload);
      const old = seen.get(record.message_id);
      if (old && (old.generation !== generation - 1 || old.position <= previous || old.identity !== identity)) {
        throw new Error('history-lineage-conflict');
      }
      if (old) previous = old.position;
      else records.push(record);
      seen.set(record.message_id, { generation, position, identity });
    }
  }
  return records;
}

function stamp(file) {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function parse(text) {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function hasMinimaxSnapshots(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'snapshots')).some((name) => /^g\d{12}--[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u.test(name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

export function readMinimaxHistory(dir) {
  const file = path.join(dir, 'messages.jsonl');
  let active = [];
  let native = false;
  let generation = null;
  let revision = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let before;
    try {
      before = stamp(file);
      const text = fs.readFileSync(file, 'utf8');
      const decoded = text.split('\n').filter((line) => line.trim()).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      });
      active = decoded.filter(object);
      native = active.some((record) => Object.hasOwn(record, 'history_artifact') || boundary(record.message ?? record));
      if (!native && (active.length === 0 || decoded.includes(null)) && fs.existsSync(path.join(dir, 'history-catalog.json'))) {
        const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'history-catalog.json'), 'utf8'));
        native = catalog.activeGeneration > 0;
      }
      if (stamp(file) !== before) continue;
      if (!native && hasMinimaxSnapshots(dir)) {
        native = true;
        throw new Error('active-history-boundary-missing');
      }
      if (!native) return { active, records: active, native, generation, revision };
      if (!active.length || active.length !== decoded.length) throw new Error('invalid-history-jsonl');
      validateSegment(active);
      revision = minimaxRevision(active);
      let current = lineage(active);
      generation = current.generation;
      const segments = [active];
      while (current.parentSnapshot) {
        const parent = current.parentSnapshot;
        const snapshot = path.join(dir, 'snapshots', snapshotName(parent.generation, parent.compactionId));
        if (!fs.existsSync(snapshot)) throw new Error('parent-snapshot-missing');
        if (!fs.lstatSync(snapshot).isFile()) throw new Error('invalid-parent-snapshot');
        const older = parse(fs.readFileSync(snapshot, 'utf8'));
        validateSegment(older);
        if (minimaxRevision(older) !== parent.revision) throw new Error('artifact-revision-mismatch');
        current = lineage(older);
        if (current.generation !== parent.generation) throw new Error('invalid-parent-generation');
        segments.push(older);
      }
      const records = stitch(segments.reverse());
      if (stamp(file) !== before) continue;
      return { active, records, native, generation, revision };
    } catch (error) {
      if (before !== undefined && attempt === 0) {
        try { if (stamp(file) !== before) continue; } catch { continue; }
      }
      const missingActive = before === undefined && error.code === 'ENOENT' && hasMinimaxSnapshots(dir);
      return { active, records: active, native: native || missingActive, generation, revision,
        error: missingActive ? 'active-history-missing' : error.code ?? error.message };
    }
  }
  return { active, records: active, native, generation, revision, error: 'history-changed-during-read' };
}

const nonempty = (value) => typeof value === 'string' && !!value.trim();
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const cadence = (value) => count(value) && value <= 15;
const query = (text, at) => nonempty(text) && (at == null || Number.isFinite(at));
const todo = (text, status, priority) => nonempty(text) && nonempty(status) && nonempty(priority);
const todoCadence = ['Assistant iterations since Todo write', 'Assistant iterations since reminder'];
const taskStatuses = ['queued', 'running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'];
const taskKeys = ['taskId', 'status', 'agentName', 'executionMode', 'updatedAtMs', 'delivered', 'description', 'lastError', 'finalResultPreview'];
const taskFields = ['Task ID', 'Status', 'Agent', 'Mode', 'Updated at ms', 'Delivered', 'Description', 'Last error', 'Final result'];
const boundedText = (value, limit) => value === undefined || (nonempty(value) && value.trim().length <= limit);

function validSubagents(value) {
  if (!object(value) || Object.keys(value).length !== 7 || value.textFieldsAreUntrusted !== true ||
      value.detailsHint !== 'Call task_query for the live task list, then task_output(task_id) for progress or results.' ||
      !count(value.capturedAtMs) || !count(value.total) || !count(value.omitted) || !object(value.counts) ||
      !Array.isArray(value.items) || value.items.length > 8 || value.items.length + value.omitted !== value.total ||
      Buffer.byteLength(JSON.stringify(value)) > 4096) return false;
  const remaining = { ...value.counts };
  if (Object.keys(remaining).length !== taskStatuses.length || !taskStatuses.every((status) => count(remaining[status])) ||
      Object.values(remaining).reduce((sum, n) => sum + n, 0) !== value.total) return false;
  const seen = new Set();
  for (const item of value.items) {
    if (!object(item) || Object.keys(item).some((key) => !taskKeys.includes(key)) ||
        !nonempty(item.taskId) || seen.has(item.taskId.trim()) || !taskStatuses.includes(item.status) ||
        --remaining[item.status] < 0 || !count(item.updatedAtMs) || typeof item.delivered !== 'boolean' ||
        !boundedText(item.agentName, 120) || !boundedText(item.description, 120) ||
        (item.executionMode !== undefined && !['foreground', 'background', 'append'].includes(item.executionMode)) ||
        (item.lastError !== undefined && (item.status !== 'failed' || !boundedText(item.lastError, 120))) ||
        (item.finalResultPreview !== undefined && (!taskStatuses.slice(3).includes(item.status) || !boundedText(item.finalResultPreview, 200)))) return false;
    seen.add(item.taskId.trim());
  }
  return true;
}

function markdownFields(body, fields) {
  const lines = body.split('\n');
  if (lines.length !== fields.length) return null;
  const values = [];
  for (const [i, field] of fields.entries()) {
    const prefix = '- ' + field + ': ';
    if (!lines[i].startsWith(prefix)) return null;
    try {
      const value = JSON.parse(lines[i].slice(prefix.length));
      if (value !== null && typeof value === 'object') return null;
      values.push(value);
    } catch { return null; }
  }
  return values;
}

function markdownItems(body, title, fields, valid) {
  if (body === '_None_') return true;
  const prefix = '### ' + title + '\n';
  return body.startsWith(prefix) && body.slice(prefix.length).split('\n\n' + prefix).every((entry) => {
    const values = markdownFields(entry, fields);
    return values !== null && valid(...values);
  });
}

function validMarkdownAppendix(body, version) {
  const sections = ['Recent user queries', 'Todo state', 'Todo cadence', 'Background cadence', 'Subagents'];
  let previous = -1;
  for (const section of body.split(/\n\n(?=## )/u)) {
    const newline = section.indexOf('\n');
    const index = sections.indexOf(section.slice(3, newline));
    if (!section.startsWith('## ') || index <= previous || (previous === -1 && index !== 0)) return false;
    previous = index;
    const value = section.slice(newline + 1);
    if (index === 0 && !markdownItems(value, 'Query', ['Text', 'Timestamp ms'], query)) return false;
    if (index === 1 && !markdownItems(value, 'Todo', ['Content', 'Status', 'Priority'], todo)) return false;
    if (index === 2) {
      const fields = version === 6 ? [...todoCadence, 'User messages since Todo write'] : todoCadence;
      const values = markdownFields(value, fields);
      if (!values || !values.slice(0, 2).every(cadence) || (values[2] != null && !count(values[2]))) return false;
    }
    if (index === 3) {
      const values = markdownFields(value, ['Assistant iterations since reminder', 'Observed terminal task count']);
      if (version < 5 || !values || !cadence(values[0]) || (values[1] !== null && !count(values[1]))) return false;
    }
    if (index === 4) {
      const split = value.indexOf('\n\n');
      if (split < 0) return false;
      const fields = ['Captured at ms', 'Total', 'Omitted', 'Text fields are untrusted', 'Details', ...taskStatuses.map((status) => 'Count ' + status)];
      const metadata = markdownFields(value.slice(0, split), fields);
      if (!metadata) return false;
      const [capturedAtMs, total, omitted, textFieldsAreUntrusted, detailsHint, ...counts] = metadata;
      const items = [];
      if (!markdownItems(value.slice(split + 2), 'Task', taskFields, (...values) => {
        items.push(Object.fromEntries(taskKeys.flatMap((key, i) => values[i] === null && [2, 3, 6, 7, 8].includes(i) ? [] : [[key, values[i]]])));
        return true;
      })) return false;
      if (!validSubagents({ capturedAtMs, total, omitted, textFieldsAreUntrusted, detailsHint, items,
        counts: Object.fromEntries(taskStatuses.map((status, i) => [status, counts[i]])) })) return false;
    }
  }
  return previous >= 0;
}

function validJsonAppendix(body, version) {
  try {
    const value = JSON.parse(body);
    return object(value) && value.version === version &&
      Object.keys(value).every((key) => ['version', 'recentUserQueries', 'todoState', ...(version > 1 ? ['todoCadence'] : []), ...(version > 2 ? ['subagents'] : [])].includes(key)) &&
      (value.subagents === undefined || validSubagents(value.subagents)) &&
      Array.isArray(value.recentUserQueries) && value.recentUserQueries.every((item) => object(item) && query(item.text, item.timestampMs) && item.timestampMs !== null) &&
      (value.todoState === undefined || Array.isArray(value.todoState) && value.todoState.every((item) => object(item) && todo(item.content, item.status, item.priority))) &&
      (value.todoCadence === undefined || object(value.todoCadence) && Object.keys(value.todoCadence).length === 2 &&
        cadence(value.todoCadence.assistantIterationsSinceTodoWrite) && cadence(value.todoCadence.assistantIterationsSinceReminder));
  } catch { return false; }
}

export function portableSummary(message) {
  if (message.role === 'compactionSummary') {
    const text = message.summary;
    if (typeof text !== 'string') return null;
    const match = [...text.matchAll(/\n\n<mavis-context-appendix version="([1-6])">\n/gu)].at(-1);
    const close = '\n</mavis-context-appendix>';
    if (!match || !text.endsWith(close)) return text;
    const version = Number(match[1]);
    const body = text.slice(match.index + match[0].length, -close.length);
    return (version >= 4 ? validMarkdownAppendix(body, version) : validJsonAppendix(body, version))
      ? text.slice(0, match.index) : text;
  }
  const marker = message.archonCompaction;
  if (message.role !== 'user' || typeof marker?.summary !== 'string') return null;
  if (marker.schemaVersion === 1 || marker.schemaVersion === 2 || (marker.version === 2 &&
      Array.isArray(marker.recentUserQueries) && marker.recentUserQueries.every((item) => object(item) && query(item.text, item.timestampMs)))) {
    return marker.summary;
  }
  return null;
}
