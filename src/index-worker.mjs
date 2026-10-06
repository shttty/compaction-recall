import { parentPort, workerData } from 'node:worker_threads';
import { StageTiming, measured } from './timing.mjs';

const customEngine = workerData?.engineModule !== undefined;
let engine, initializationError, initializationFailed = false;
try {
  if (customEngine && (typeof workerData.engineModule !== 'string' || new URL(workerData.engineModule).protocol !== 'file:')) {
    throw new TypeError('engineModule must be an explicit file URL');
  }
  const { createWorkerEngine } = await import(customEngine ? workerData.engineModule : './default-worker-engine.mjs');
  engine = await createWorkerEngine(workerData?.engineOptions);
} catch (error) {
  initializationFailed = true;
  initializationError = error;
}
let timing, active = [], staging = [], generation = 0, partial = null, eligibleCount = 0, append = false;

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
    await engine.dispose?.();
    return;
  }
  if (message.type === 'begin') {
    generation = message.generation;
    eligibleCount = message.eligibleCount;
    append = message.append;
    staging = append ? active.slice() : [];
    partial = null;
    timer?.mark('worker_maintenance', { kind: append ? 'incremental_update' : 'build_or_rebuild', entries: eligibleCount, execution: 'worker_thread' });
    return;
  }
  if (message.generation !== generation) throw new Error('Obsolete generation');
  if (message.type === 'batch') {
    timer?.mark('worker_maintenance', { kind: 'pretokenize', entries: message.entries.length, execution: 'worker_thread' });
    const entries = measured(timer, 'live_or_eligible_tokenization', () => engine.prepareEntry
      ? message.entries.map(entry => {
        state.engineOperation = true;
        const prepared = engine.prepareEntry(entry);
        state.engineOperation = false;
        return prepared;
      }) : message.entries);
    staging.push(...entries);
  } else if (message.type === 'large_start') partial = { entry: message.entry, chunks: [] };
  else if (message.type === 'large_chunk') partial.chunks.push(message.text);
  else if (message.type === 'large_end') {
    timer?.mark('worker_maintenance', { kind: 'pretokenize', entries: 1, execution: 'worker_thread' });
    partial.entry.message.content = measured(timer, 'large_text_assembly', () => partial.chunks.join(''));
    const entry = measured(timer, 'live_or_eligible_tokenization', () => {
      if (!engine.prepareEntry) return partial.entry;
      state.engineOperation = true;
      const prepared = engine.prepareEntry(partial.entry);
      state.engineOperation = false;
      return prepared;
    });
    staging.push(entry);
    partial = null;
  } else if (message.type === 'commit') {
    active = staging;
    state.engineOperation = true;
    const result = await engine.commit(active, { eligibleCount, append, timer });
    state.engineOperation = false;
    return { ...result, ...(timer ? { heapUsed: process.memoryUsage().heapUsed } : {}) };
  } else if (message.type === 'query') {
    state.engineOperation = true;
    const result = await engine.query(message.query, { mode: message.mode, options: message.options, timer });
    state.engineOperation = false;
    return result;
  } else throw new Error('Unknown worker command');
}

async function respond(message) {
  if (message.timing && !timing) timing = new StageTiming();
  const timer = message.timing ? timing : undefined;
  const state = { engineOperation: false };
  try {
    if (initializationFailed) throw initializationError;
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
