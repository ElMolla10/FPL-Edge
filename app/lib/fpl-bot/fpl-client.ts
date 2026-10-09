/**
 * The bot's ONLY authenticated FPL HTTP client. Every URL and request body is bound to the configured bot entry
 * (assertBotEntry), calls are spaced (>= 1.5 s + jitter), capped per run, and a 429 / 5xx stops the run (no retry
 * loops). POST methods throw unless the runner explicitly armed `allowPost` for a live, fully validated step.
 */
import type { TokenProvider } from "../personal-fpl-transfer/client";
import { BOT_LIMITS } from "./config";
import { redact } from "./crypto";
import type { PicksPayload, TransfersPayload } from "./payloads";
import type { BotMyTeam } from "./types";

export const FPL_API = "https://fantasy.premierleague.com/api";
export const BOT_USER_AGENT = "FPL-Edge-Bot/1.0 (automated, owner-operated)";

export class BotHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: "rate-limited" | "upstream" | "auth" | "bad-response" | "cap" | "post-disabled" | "client",
    message: string,
  ) {
    super(message);
    this.name = "BotHttpError";
  }
}

export type BotClientOptions = {
  entryId: string;
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Must be explicitly armed by the runner right before a validated live POST. */
  allowPost?: boolean;
};

export type PostResult = { status: number; ok: boolean; excerpt: string; body: unknown };

export class BotFplClient {
  readonly entryId: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private allowPost: boolean;
  private authedCalls = 0;
  private forcedRefreshUsed = false;
  private lastCallAt = 0;

  constructor(options: BotClientOptions) {
    if (!/^\d{1,12}$/.test(options.entryId)) throw new Error("bot client needs a numeric entry id");
    this.entryId = options.entryId;
    this.tokens = options.tokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.allowPost = options.allowPost === true;
  }

  get callsMade(): number {
    return this.authedCalls;
  }

  armPosts(armed: boolean): void {
    this.allowPost = armed;
  }

  private async space(): Promise<void> {
    if (this.lastCallAt === 0) return;
    const wait = BOT_LIMITS.authedSpacingMs + Math.floor(this.random() * BOT_LIMITS.authedJitterMs);
    await this.sleep(wait);
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    if (this.authedCalls >= BOT_LIMITS.maxAuthedCallsPerRun) throw new BotHttpError(0, "cap", "authed call cap reached for this run");
    await this.space();
    const once = async (forceRefresh: boolean) => {
      this.authedCalls++;
      this.lastCallAt = Date.now();
      return this.fetchImpl(`${FPL_API}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          "X-API-Authorization": `Bearer ${await this.tokens.getAccessToken({ forceRefresh })}`,
          Accept: "application/json",
          "User-Agent": BOT_USER_AGENT,
        },
      });
    };
    let response = await once(false);
    if ((response.status === 401 || response.status === 403) && !this.forcedRefreshUsed) {
      this.forcedRefreshUsed = true;
      response = await once(true);
    }
    if (response.status === 429) throw new BotHttpError(429, "rate-limited", "FPL rate limited the bot");
    if (response.status >= 500) throw new BotHttpError(response.status, "upstream", `FPL upstream ${response.status}`);
    if (response.status === 401 || response.status === 403) throw new BotHttpError(response.status, "auth", `FPL auth rejected (${response.status})`);
    return response;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.call(path, { method: "GET" });
    if (!response.ok) throw new BotHttpError(response.status, "client", `GET ${path.split("/")[1]} failed ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BotHttpError(response.status, "bad-response", "FPL returned a non-JSON body (game updating?)");
    }
  }

  /** GET /api/me/ -> the entry id the token belongs to (null when FPL does not say). */
  async me(): Promise<{ entry: string | null }> {
    const body = await this.getJson<{ player?: { entry?: unknown } | null }>("/me/");
    const raw = body?.player?.entry;
    const entry = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? String(raw) : null;
    return { entry };
  }

  async myTeam(): Promise<BotMyTeam> {
    const team = await this.getJson<BotMyTeam>(`/my-team/${this.entryId}/`);
    if (!team || !Array.isArray(team.picks) || !team.transfers) throw new BotHttpError(200, "bad-response", "my-team shape changed");
    return team;
  }

  private async post(path: string, body: unknown, referer: string): Promise<PostResult> {
    if (!this.allowPost) throw new BotHttpError(0, "post-disabled", "POST attempted while not armed (shadow / failed checks)");
    const response = await this.call(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://fantasy.premierleague.com",
        Referer: referer,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, ok: response.ok, excerpt: redact(text, 300), body: parsed };
  }

  async postTransfers(payload: TransfersPayload): Promise<PostResult> {
    if (String(payload.entry) !== this.entryId) throw new BotHttpError(0, "client", "transfer payload entry is not the bot entry");
    return this.post("/transfers/", payload, "https://fantasy.premierleague.com/transfers");
  }

  async postPicks(payload: PicksPayload): Promise<PostResult> {
    return this.post(`/my-team/${this.entryId}/`, payload, "https://fantasy.premierleague.com/my-team");
  }
}
