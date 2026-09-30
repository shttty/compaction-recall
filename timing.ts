/** Optional benchmark observer. No clock reads or logging when absent. */
export interface StageTimer { run<T>(stage: string, work: () => T): T }
export function measured<T>(timer: StageTimer | undefined, stage: string, work: () => T): T {
  return timer ? timer.run(stage, work) : work();
}
