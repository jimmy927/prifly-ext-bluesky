/**
 * The Bluesky connection every tool goes through: logs in lazily with the
 * reader's handle and app password, reuses the session, logs in again once
 * when a token has expired, paces requests, and turns every failure into a
 * message that says what to do. The agent itself is made by `makeAgent`, so
 * tests give it a fake.
 */

import type { AgentLike } from "./types";

export const APP_PASSWORDS_URL = "https://bsky.app/settings/app-passwords";
/** The vault entry (an API token) that holds the app password; the manifest's `vault` list names it. */
export const VAULT_ENTRY = "bluesky";

/** What a session is told when Bluesky cannot be used; thrown, so the tool call is an error with this text. */
export class BlueskyError extends Error {
  override name = "BlueskyError";
}

export function notSignedIn(missing: string): string {
  return [
    `Not signed in to Bluesky: ${missing}.`,
    "To sign in:",
    `1. Create an app password at ${APP_PASSWORDS_URL} (Add App Password; tick "Allow access to your direct messages" if you want to send messages). Do not use your main password.`,
    `2. In prifly, open Settings -> Vault and add an API token named "${VAULT_ENTRY}" whose value is that app password (keep it at level 1).`,
    "3. In prifly, open Settings -> Extensions -> Bluesky and type your handle (for example you.bsky.social).",
  ].join("\n");
}

export const WRONG_PASSWORD =
  `Bluesky refused the sign-in: the handle or app password is wrong. Check the handle in Settings -> Extensions -> Bluesky, and make a new app password at ${APP_PASSWORDS_URL} ` +
  `if needed, then replace the "${VAULT_ENTRY}" entry in Settings -> Vault. (Use an app password, not your main password.)`;

export type Credentials = { handle: string; password: string };

export type ClientDeps = {
  /** The handle (a setting) and the app password (the vault); empty when not set. */
  credentials: () => Promise<{ handle: string; password: string | null }>;
  /** Makes an agent whose HTTP requests go through `gate` and whose responses are shown to `observe`. */
  makeAgent: (hooks: AgentHooks) => AgentLike;
  /** The smallest gap between two requests. */
  minGapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type AgentHooks = {
  /** Awaited before every HTTP request: waits the pacing gap out. */
  gate: () => Promise<void>;
  /** Given the headers of every HTTP response, for the rate-limit ones. */
  observe: (headers: { get(name: string): string | null }) => void;
};

const DEFAULT_GAP_MS = 300;
/** A rate-limit wait longer than this is reported instead of waited for. */
const MAX_WAIT_MS = 30_000;

type Failure = {
  status?: number;
  error?: string;
  message: string;
  headers?: Record<string, string>;
};

/**
 * Our own error, if that is what `error` is or wraps: the SDK catches whatever its fetch throws
 * (our pacing gate included) and rethrows it as an XRPCError with the original as `cause`.
 */
function ownError(error: unknown): BlueskyError | undefined {
  if (error instanceof BlueskyError) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof BlueskyError ? cause : undefined;
}

function failureOf(error: unknown): Failure {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const headers =
    typeof e["headers"] === "object" ? (e["headers"] as Record<string, string>) : undefined;
  return {
    ...(typeof e["status"] === "number" ? { status: e["status"] } : {}),
    ...(typeof e["error"] === "string" ? { error: e["error"] } : {}),
    message: error instanceof Error ? error.message : String(error),
    ...(headers === undefined ? {} : { headers }),
  };
}

function headerOf(failure: Failure, name: string): string | undefined {
  for (const [key, value] of Object.entries(failure.headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function expired(failure: Failure): boolean {
  return (
    failure.error === "ExpiredToken" ||
    failure.error === "InvalidToken" ||
    failure.error === "AuthenticationRequired" ||
    failure.status === 401
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "14:05:09 UTC" */
function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** Message for a 429: when to try again, from `ratelimit-reset` (epoch seconds) or `retry-after`. */
export function rateLimited(failure: Failure | { resetAt: number }, now: number): string {
  let resetAt: number | undefined;
  if ("resetAt" in failure) resetAt = failure.resetAt;
  else {
    const reset = Number(headerOf(failure, "ratelimit-reset"));
    const retry = Number(headerOf(failure, "retry-after"));
    if (Number.isFinite(reset) && reset > 0) resetAt = reset * 1000;
    else if (Number.isFinite(retry) && retry > 0) resetAt = now + retry * 1000;
  }
  if (resetAt === undefined) {
    return "Bluesky's rate limit was reached. Wait a few minutes before trying again.";
  }
  const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  const wait = seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
  return `Bluesky's rate limit was reached. Try again in about ${wait} (after ${clock(resetAt)}).`;
}

export class Bluesky {
  private live: { key: string; agent: Promise<AgentLike> } | null = null;
  private nextSlot = 0;
  private blockedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gap: number;

  private readonly deps: ClientDeps;

  constructor(deps: ClientDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.gap = deps.minGapMs ?? DEFAULT_GAP_MS;
  }

  /** Waits for this request's slot: the gap after the last one, and any rate-limit reset. */
  private readonly gate = async (): Promise<void> => {
    const now = this.now();
    if (this.blockedUntil - now > MAX_WAIT_MS) {
      throw new BlueskyError(rateLimited({ resetAt: this.blockedUntil }, now));
    }
    const slot = Math.max(now, this.nextSlot, this.blockedUntil);
    this.nextSlot = slot + this.gap;
    if (slot > now) await this.sleep(slot - now);
  };

  /** Bluesky tells how many requests are left; with none left, the next waits for the reset. */
  private readonly observe = (headers: { get(name: string): string | null }): void => {
    const remaining = headers.get("ratelimit-remaining");
    const reset = Number(headers.get("ratelimit-reset"));
    if (remaining !== null && Number(remaining) <= 0 && Number.isFinite(reset) && reset > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, reset * 1000);
    }
  };

  private async login(credentials: Credentials): Promise<AgentLike> {
    const agent = this.deps.makeAgent({ gate: this.gate, observe: this.observe });
    try {
      await agent.login(credentials.handle, credentials.password);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.status === 400 || failure.status === 401 || expired(failure)) {
        throw new BlueskyError(WRONG_PASSWORD);
      }
      throw this.explain(error);
    }
    return agent;
  }

  /** The logged-in agent: made and logged in on first use, again when the credentials change. */
  private async session(): Promise<AgentLike> {
    const { handle, password } = await this.deps.credentials();
    const name = handle.trim().replace(/^@/, "");
    if (name === "") throw new BlueskyError(notSignedIn("no handle is set"));
    if (password === null || password.trim() === "") {
      throw new BlueskyError(notSignedIn("no app password is in the vault"));
    }
    const key = `${name}\n${password}`;
    if (this.live?.key !== key) {
      this.live = { key, agent: this.login({ handle: name, password: password.trim() }) };
    }
    const mine = this.live;
    try {
      return await mine.agent;
    } catch (error) {
      if (this.live === mine) this.live = null;
      throw error;
    }
  }

  /** The reader-facing error for a failed call. */
  private explain(error: unknown): BlueskyError {
    const ours = ownError(error);
    if (ours !== undefined) return ours;
    const failure = failureOf(error);
    if (failure.status === 429) return new BlueskyError(rateLimited(failure, this.now()));
    if (/token scope/i.test(failure.message)) {
      return new BlueskyError(
        `Bluesky refused this: the app password does not allow it (${failure.message}). Make a new app password at ${APP_PASSWORDS_URL} with "Allow access to your direct messages" ticked, and put it in the "${VAULT_ENTRY}" vault entry.`,
      );
    }
    if (failure.status === undefined || failure.status < 100) {
      return new BlueskyError(
        `Could not reach Bluesky (network error: ${failure.message}). Check the connection and try again.`,
      );
    }
    if (failure.status >= 500) {
      return new BlueskyError(
        `Bluesky's servers answered ${failure.status} (${failure.message}). Try again in a moment.`,
      );
    }
    if (expired(failure)) {
      return new BlueskyError(
        `Bluesky kept refusing the session (${failure.message}). Check the handle and the "${VAULT_ENTRY}" app password.`,
      );
    }
    return new BlueskyError(`Bluesky said no: ${failure.message}`);
  }

  /**
   * Runs `fn` with the logged-in agent. A token that is expired or refused logs in again, once, and
   * runs `fn` again; every other failure ends as a `BlueskyError` with a message to act on.
   */
  async run<T>(fn: (agent: AgentLike) => Promise<T>): Promise<T> {
    let again = true;
    for (;;) {
      const agent = await this.session();
      try {
        return await fn(agent);
      } catch (error) {
        if (again && expired(failureOf(error)) && ownError(error) === undefined) {
          again = false;
          this.live = null;
          continue;
        }
        throw this.explain(error);
      }
    }
  }
}
