/**
 * Non-blocking scheduling for type-B transfer planning.
 * Prefer requestIdleCallback; fall back to setTimeout. Never run deep search
 * on the Overview critical path — call sites must use mode:'shallow' sync, then
 * optionally scheduleDeferred for a deeper upgrade after paint.
 */

export type DeferredHandle = { cancel: () => void };

export type ScheduleDeferredOptions = {
  /** Max wait before running even if the browser stays busy (ms). */
  timeout?: number;
  /** Extra delay before idle scheduling (ms). Default 0. */
  delayMs?: number;
};

/**
 * Run `fn` after the current paint / when the browser is idle.
 * Safe for Transfers deep ranking and Overview upgrade passes.
 */
export function scheduleDeferred(
  fn: () => void,
  options: ScheduleDeferredOptions = {},
): DeferredHandle {
  const timeout = Math.max(0, options.timeout ?? 400);
  const delayMs = Math.max(0, options.delayMs ?? 0);
  let cancelled = false;
  let idleId: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let delayId: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (cancelled) return;
    try {
      fn();
    } catch {
      // Callers own error UI; never let deferred work crash the tab.
    }
  };

  const armIdle = () => {
    if (cancelled) return;
    const ric = typeof window !== "undefined"
      ? (window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
          cancelIdleCallback?: (id: number) => void;
        }).requestIdleCallback
      : undefined;
    if (typeof ric === "function") {
      idleId = ric(run, { timeout });
    } else {
      timeoutId = setTimeout(run, Math.min(timeout, 32));
    }
  };

  if (delayMs > 0) {
    delayId = setTimeout(armIdle, delayMs);
  } else {
    armIdle();
  }

  return {
    cancel: () => {
      cancelled = true;
      if (delayId !== undefined) clearTimeout(delayId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (idleId !== undefined && typeof window !== "undefined") {
        (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idleId);
      }
    },
  };
}

/** True when rules disable the deep future free-transfer beam (Overview / shallow). */
export function isShallowPlanning(rules: { futureBeamWidth?: number; beamWidth?: number }): boolean {
  const beam = rules.futureBeamWidth ?? rules.beamWidth ?? 0;
  return beam <= 0;
}

/** Inverse of isShallowPlanning — deep multi-GW HOLD continuation search enabled. */
export function isDeepFutureSearchEnabled(rules: { futureBeamWidth?: number; beamWidth?: number }): boolean {
  return !isShallowPlanning(rules);
}
