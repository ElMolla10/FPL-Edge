interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  error?: string;
  meta: Record<string, unknown>;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    // Worker secrets, set via `wrangler secret put` -- never committed, so these are optional
    // here and billing routes must check for their absence (see app/lib/billing/env.ts). Paymob,
    // not Stripe: Stripe doesn't support Egyptian merchant accounts.
    PAYMOB_API_KEY?: string;
    PAYMOB_INTEGRATION_ID?: string;
    PAYMOB_HMAC_SECRET?: string;
    PAYMOB_IFRAME_ID?: string;
    // Unlike Stripe (a dashboard-managed Price object referenced by id), Paymob's classic Accept
    // flow requires the amount in the request body directly -- this is genuinely new config this
    // app didn't need before the provider switch, not an oversight carried over from Stripe.
    PAYMOB_SEASON_PRICE_EGP_CENTS?: string;
  };
}
