// @ts-check
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

/**
 * Optional observer. An absent timer performs no measurement or logging.
 * @typedef {{ run: <T>(stage: string, work: () => T) => T }} StageTimer
 */
/**
 * @template T
 * @param {StageTimer | undefined} timer
 * @param {string} stage
 * @param {() => T} work
 * @returns {T}
 */
export function measured(timer, stage, work) {
  return timer ? timer.run(stage, work) : work();
}

/**
 * @typedef {{
 *   type: 'span', execution: string, stage: string, id: string,
 *   parentId: string | null, startMs: number, durationMs?: number, outcome?: string
 * }} Span
 * @typedef {Span | { type: 'mark', stage: string, atMs?: number, parentId?: string | null, [key: string]: unknown }} TimingEvent
 */
const MAX_EVENTS = 10_000;
/** @type {Record<string, true>} */
const numericFields = {
  count: true, entries: true, elapsedMs: true, workerMs: true, roundtripMs: true, mainThreadMs: true, wallMs: true,
  mainExtractionMs: true, workerHeapBytes: true, userCounter: true, toolCounter: true, userCycles: true, toolRounds: true,
  windowStartMs: true, windowEndMs: true, samples: true, maxLagMs: true, p95LagMs: true, over16ms: true,
  nodeProcessUptimeMs: true, requestId: true, sinceRequestMs: true,
};
/** @type {Record<string, Record<string, true>>} */
const labelFields = {
  operation: { begin: true, batch: true, large_start: true, large_chunk: true, large_end: true, commit: true, query: true },
  kind: { incremental_update: true, build_or_rebuild: true, initial_build: true, branch_rebuild: true, pretokenize: true, activation: true },
  execution: { worker_startup: true, background_worker: true, synchronous_transfer: true, background_worker_with_main_thread_extraction: true, awaited_readiness: true, synchronous_main_thread: true, worker_thread: true },
  trigger: { lifecycle: true, session_start: true, session_switch: true, session_compact: true, session_tree: true, agent_end: true, tool_result: true, turn_end: true },
};

/**
 * Inclusive spans: IDs identify parents across async tasks and worker transfers.
 * @implements {StageTimer}
 */
export class StageTiming {
  /** @readonly @type {number} */
  origin;
  /** @readonly */
  timerId = randomUUID();
  /** @readonly @type {TimingEvent[]} */
  events = [];
  /** @readonly @type {AsyncLocalStorage<string | null>} */
  context = new AsyncLocalStorage();
  /** @private */
  sequence = 0;
  /** @private */
  dropped = 0;

  /** @readonly @type {() => number} */
  clock;
  /** @param {() => number} [clock] */
  constructor(clock = () => performance.now()) { this.clock = clock; this.origin = clock(); }
  capture() { return { parentId: this.context.getStore() ?? null, clockOriginMs: this.origin }; }
  /**
   * @template T
   * @param {string | null} parentId
   * @param {() => T} work
   * @returns {T}
   */
  withParent(parentId, work) { return this.context.run(parentId, work); }
  /** @param {string} stage @returns {Span} */
  start(stage) {
    return { type: 'span', execution: isMainThread ? 'synchronous_main_thread' : 'worker_thread', stage,
      id: `${this.timerId}:${++this.sequence}`, parentId: this.context.getStore() ?? null, startMs: this.clock() - this.origin };
  }
  /** @private @param {TimingEvent} event */
  record(event) {
    if (this.events.length < MAX_EVENTS) this.events.push(event);
    else this.dropped++;
  }
  /** @param {Span} span @param {string} [outcome] */
  end(span, outcome = 'ok') {
    this.record({ ...span, durationMs: Math.max(0, this.clock() - this.origin - span.startMs), outcome });
  }
  /**
   * @template T
   * @param {string} stage
   * @param {() => T} work
   * @returns {T}
   */
  run(stage, work) {
    const span = this.start(stage);
    try { const result = this.context.run(span.id, work); this.end(span); return result; }
    catch (error) { this.end(span, 'error'); throw error; }
  }
  /**
   * @template T
   * @param {string} stage
   * @param {() => T | Promise<T>} work
   * @returns {Promise<T>}
   */
  async runAsync(stage, work) {
    const span = this.start(stage); span.execution = 'awaited_walltime';
    try { const result = await this.context.run(span.id, work); this.end(span); return result; }
    catch (error) { this.end(span, 'error'); throw error; }
  }
  /** @param {string} stage @param {Record<string, unknown>} [fields] */
  mark(stage, fields = {}) {
    /** @type {TimingEvent} */
    const event = { type: 'mark', execution: isMainThread ? 'synchronous_main_thread' : 'worker_thread', stage, atMs: this.clock() - this.origin, parentId: this.context.getStore() ?? null };
    for (const [key, value] of Object.entries(fields)) {
      if ((Object.hasOwn(numericFields, key) && typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && Object.hasOwn(labelFields, key) && Object.hasOwn(labelFields[key], value))) event[key] = value;
    }
    this.record(event);
  }
  /** @param {TimingEvent[]} events @param {number} clockOriginMs */
  merge(events, clockOriginMs) {
    const offset = clockOriginMs - this.origin;
    for (const event of events) {
      this.record(event.type === 'span' ? { ...event, startMs: event.startMs + offset } :
        { ...event, ...(event.atMs === undefined ? {} : { atMs: event.atMs + offset }) });
    }
  }
  /** @param {string} [path] */
  flush(path) {
    if (!path || !this.events.length) return;
    const events = this.events.splice(0);
    if (this.dropped) { events.push({ type: 'mark', stage: 'dropped_timing_events', count: this.dropped }); this.dropped = 0; }
    /** @type {number | undefined} */
    let fd;
    try {
      fd = openSync(path, 'a', 0o600);
      fchmodSync(fd, 0o600);
      for (const event of events) {
        writeSync(fd, JSON.stringify({ processId: process.pid, timerId: this.timerId, clockOriginMs: this.origin, ...event }) + '\n');
      }
    } catch { /* Diagnostics must not alter outputs or errors. */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Output-neutral. */ } } }
  }
}

export const recallTiming = process.env.PI_RECALL_TIMING_FILE ? new StageTiming() : undefined;
export function flushTiming() { recallTiming?.flush(process.env.PI_RECALL_TIMING_FILE); }
