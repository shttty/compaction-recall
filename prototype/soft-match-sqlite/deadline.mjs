// The worker and parent use absolute monotonic performance timestamps.
export const queryNow = () => performance.timeOrigin + performance.now();

export function createQueryCheck(deadlineAt, timeoutMs) {
  if (deadlineAt === undefined) return undefined;
  return () => {
    if (queryNow() >= deadlineAt) throw Object.assign(
      new Error(`history_recall timed out after ${timeoutMs} ms; narrow the query or use history_grep`),
      { name: 'TimeoutError' },
    );
  };
}
