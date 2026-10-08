import { parentPort, workerData } from 'node:worker_threads';
import { StageTiming, measured } from '../observability/timing.mjs';
import { createWorkerEngine } from './default-worker-engine.mjs';

let timing;
const slots = new Map();

function slotFor(indexKey, create = false) {
  const key = indexKey === undefined ? "default" : String(indexKey);
  let slot = slots.get(key);
  if (!slot && create) {
    slot = { engine: createWorkerEngine(workerData?.engineOptions), active: [], staging: [], generation: 0, eligibleCount: 0, append: false, includeIneligible: false, partial: null };
    slots.set(key, slot);
  }
  return slot;
}

// Keep worker execution labels while measuring the complete asynchronous operation.
async function measuredAsync(timer, stage, work) {
  if (!timer) return work();
  const span = timer.start(stage);
  try {
    const result = await timer.withParent(span.id, work);
    timer.end(span);
    return result;
  } catch (error) {
    timer.end(span, 'error');
    throw error;
  }
}

async function handle(message, timer, state) {
  if (message.type === 'dispose') {
    await Promise.all([...slots.values()].map(slot => slot.engine.dispose()));
    slots.clear();
    return;
  }
  if (message.type === 'dispose_index') {
    const slot = slotFor(message.indexKey);
    if (slot) { await slot.engine.dispose(); slots.delete(String(message.indexKey)); }
    return;
  }
  const slot = slotFor(message.indexKey, message.type === 'begin');
  if (!slot) throw new Error('Unknown worker index');
  if (message.type === 'begin') {
    slot.generation = message.generation;
    slot.eligibleCount = message.eligibleCount;
    slot.append = message.append;
    slot.includeIneligible = message.includeIneligible === true;
    slot.staging = slot.append ? slot.active.slice() : [];
    slot.partial = null;
    timer?.mark('worker_maintenance', { kind: slot.append ? 'incremental_update' : 'build_or_rebuild', entries: message.eligibleCount, execution: 'worker_thread' });
    return;
  }
  if (message.generation !== slot.generation) throw new Error('Obsolete generation');
  if (message.type === 'batch') {
    slot.staging.push(...message.entries);
  } else if (message.type === 'large_start') slot.partial = { entry: message.entry, chunks: [] };
  else if (message.type === 'large_chunk') slot.partial.chunks.push(message.text);
  else if (message.type === 'large_end') {
    slot.partial.entry.message.content = measured(timer, 'large_text_assembly', () => slot.partial.chunks.join(''));
    slot.staging.push(slot.partial.entry);
    slot.partial = null;
  } else if (message.type === 'commit') {
    slot.active = slot.staging;
    state.engineOperation = true;
    const result = await slot.engine.commit(slot.active, { eligibleCount: slot.eligibleCount, append: slot.append, includeIneligible: slot.includeIneligible, timer });
    state.engineOperation = false;
    return { ...result, ...(timer ? { heapUsed: process.memoryUsage().heapUsed } : {}) };
  } else if (message.type === 'query') {
    state.engineOperation = true;
    const result = await slot.engine.query(message.query, { mode: message.mode, options: message.options, timer });
    state.engineOperation = false;
    return result;
  } else throw new Error('Unknown worker command');
}

async function respond(message) {
  if (message.timing && !timing) timing = new StageTiming();
  const timer = message.timing ? timing : undefined;
  const state = { engineOperation: false };
  try {
    const work = () => measuredAsync(timer, `worker_${message.type}`, () => handle(message, timer, state));
    const result = await (timer ? timer.withParent(message.timing.parentId, work) : work());
    parentPort.postMessage({
      requestId: message.requestId, generation: message.generation, result,
      ...(timer ? { stages: timer.events.splice(0), timingOrigin: timer.origin } : {}),
    });
  } catch (error) {
    parentPort.postMessage({
      requestId: message.requestId, generation: message.generation,
      error: error?.message ?? String(error),
      errorName: error?.name ?? 'Error', ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
      ...(state.engineOperation ? { engineError: true } : {}),
      ...(timer ? { stages: timer.events.splice(0), timingOrigin: timer.origin } : {}),
    });
  }
}
let queue = Promise.resolve();
parentPort.on('message', message => { queue = queue.then(() => respond(message)); });
