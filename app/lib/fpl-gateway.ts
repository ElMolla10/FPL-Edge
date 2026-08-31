export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ConcurrencyLimiter = { run<T>(operation: () => Promise<T>): Promise<T> };

export function createConcurrencyLimiter(maximum: number): ConcurrencyLimiter {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Concurrency must be a positive integer.");
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active++;
          operation().then(resolve, reject).finally(release);
        };
        if (active < maximum) start();
        else queue.push(start);
      });
    },
  };
}

export class GatewayTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayTimeoutError";
  }
}

export type FetchWithTimeoutOptions = {
  fetcher: FetchLike;
  limiter: ConcurrencyLimiter;
  timeoutMs: number;
  headers?: Record<string, string>;
};

// Shared by every gateway that calls a real, rate-sensitive upstream (Mini-League's official-FPL
// gateway, the population-percentile sampler): bounded concurrency plus a hard per-request timeout
// that actually aborts the in-flight fetch, not just races it. Extracted so both gateways share one
// implementation instead of two copies that agree today and drift the next time either is touched
// independently -- exactly the failure class this project has caught repeatedly. The `timedOut` flag
// (not the identity of whichever promise wins the race) is what decides whether a GatewayTimeoutError
// is thrown, so this stays correct regardless of which of the two raced promises settles first.
export async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions): Promise<Response> {
  return options.limiter.run(async () => {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Request timed out."));
        reject(new GatewayTimeoutError(`Request timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs);
    });
    try {
      return await Promise.race([
        options.fetcher(url, { headers: options.headers ?? { Accept: "application/json", "User-Agent": "FPL-Edge/1.0" }, signal: controller.signal }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut) throw new GatewayTimeoutError(`Request timed out after ${options.timeoutMs}ms.`);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });
}
