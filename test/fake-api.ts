/**
 * A fake of prifly's `api`, for an extension's own tests: everything it is
 * asked to show, log, register, confirm or say as its status is kept to look
 * at, `api.state` is kept in memory, and `api.connections`
 * runs against a fake token endpoint and a fake provider instead of a real
 * account. Copy it into a plugin's `test/` as it is; nothing in it is
 * specific to the template.
 *
 *     const fake = fakeApi({ connections: fakeConnections({ accounts: [ACCOUNT], provider }) });
 *     activate(fake.api);
 *     expect(await fake.callTool("my_tool", {})).toBe("…");
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConfirmSpec,
  Decoration,
  ExtensionApi,
  ExtensionConnection,
  ExtensionConnectionsApi,
  ExtensionFetchOptions,
  ExtensionLogEntry,
  ExtensionLogRead,
  ExtensionNeedsSignIn,
  ExtensionPickAnswer,
  ExtensionStateApi,
  ExtensionTool,
  ExtensionToolContext,
  LauncherFlag,
  SettingValues,
} from "@prifly/extension-api";

/** A connected account the fake knows, with the scopes it was granted. */
export type FakeAccount = { id: string; provider: string; account: string; scopes: string[] };

/** The provider's API: what a request with a live token gets back. */
export type FakeProvider = (request: Request) => Response | Promise<Response>;

/**
 * prifly's side of a grant: which access token each connection gets, and
 * which grants the provider ended. `revoke` makes `fetch` and `token` answer
 * `needsSignIn`, as a revoked or expired grant does; `signIn` revives it.
 */
export class FakeTokenEndpoint {
  private readonly issuedCount = new Map<string, number>();
  private readonly ended = new Set<string>();

  /** A fresh token for the connection, or null when its grant ended. */
  issue(connection: string): string | null {
    if (this.ended.has(connection)) return null;
    const count = (this.issuedCount.get(connection) ?? 0) + 1;
    this.issuedCount.set(connection, count);
    return `token-${connection}-${count}`;
  }

  revoke(connection: string): void {
    this.ended.add(connection);
  }

  revive(connection: string): void {
    this.ended.delete(connection);
  }

  isEnded(connection: string): boolean {
    return this.ended.has(connection);
  }

  /** How many tokens the connection was given. */
  issued(connection: string): number {
    return this.issuedCount.get(connection) ?? 0;
  }
}

export type FakeConnections = {
  connections: ExtensionConnectionsApi;
  endpoint: FakeTokenEndpoint;
  accounts: FakeAccount[];
  /** Every request `fetch` sent to the provider, its `Authorization` header set. */
  requests: Request[];
};

const NO_PROVIDER: FakeProvider = () => new Response("no fake provider", { status: 404 });

/**
 * `api.connections` over fake accounts. `provider` answers what `fetch`
 * sends; `scopes` is what the manifest lets `signIn` ask for, by provider
 * (left out, anything). `signIn` with no `connection` connects a new
 * account `<provider>-<n>@example.com`.
 */
export function fakeConnections(
  options: {
    accounts?: FakeAccount[];
    provider?: FakeProvider;
    scopes?: Record<string, string[]>;
  } = {},
): FakeConnections {
  const accounts = [...(options.accounts ?? [])];
  const endpoint = new FakeTokenEndpoint();
  const requests: Request[] = [];
  const provider = options.provider ?? NO_PROVIDER;

  const find = (id: string): FakeAccount => {
    const account = accounts.find((each) => each.id === id);
    if (account === undefined) throw new Error(`No connection ${id}`);
    return account;
  };
  const needsSignIn = (account: FakeAccount): ExtensionNeedsSignIn => ({
    needsSignIn: { connection: account.id, provider: account.provider, account: account.account },
  });
  const view = (account: FakeAccount): ExtensionConnection => ({
    id: account.id,
    provider: account.provider,
    account: account.account,
    client: "prifly",
    scopes: [...account.scopes],
    state: endpoint.isEnded(account.id) ? "needs-sign-in" : "ok",
  });

  const connections: ExtensionConnectionsApi = {
    list: (wanted) =>
      accounts.filter((each) => wanted === undefined || each.provider === wanted).map(view),
    async fetch(id, request, _options?: ExtensionFetchOptions) {
      const account = find(id);
      const token = endpoint.issue(id);
      if (token === null) return needsSignIn(account);
      // Two calls: Bun types a string and a Request as separate overloads of the constructor.
      const sent = typeof request === "string" ? new Request(request) : new Request(request);
      sent.headers.set("Authorization", `Bearer ${token}`);
      requests.push(sent);
      return await provider(new Request(sent));
    },
    async token(id) {
      const account = find(id);
      const token = endpoint.issue(id);
      return token === null ? needsSignIn(account) : { token };
    },
    async signIn(providerName, scopes, signInOptions) {
      const allowed = options.scopes?.[providerName];
      const refused = scopes.filter((scope) => allowed !== undefined && !allowed.includes(scope));
      if (refused.length > 0) {
        return { ok: false, message: `Not in the manifest: ${refused.join(", ")}` };
      }
      const existing = signInOptions?.connection;
      if (existing !== undefined) {
        const account = find(existing);
        account.scopes = [...new Set([...account.scopes, ...scopes])];
        endpoint.revive(existing);
        return { ok: true, connection: account.id, account: account.account };
      }
      const account: FakeAccount = {
        id: `${providerName}-${accounts.length + 1}`,
        provider: providerName,
        account: `${providerName}-${accounts.length + 1}@example.com`,
        scopes: [...scopes],
      };
      accounts.push(account);
      return { ok: true, connection: account.id, account: account.account };
    },
  };
  return { connections, endpoint, accounts, requests };
}

/**
 * `api.state` in memory: documents in `documents`, logs in `logs`. Writes
 * run in call order, which is all a single-threaded test needs.
 */
export function fakeState(): {
  state: ExtensionStateApi;
  documents: Map<string, unknown>;
  logs: Map<string, ExtensionLogEntry[]>;
} {
  const documents = new Map<string, unknown>();
  const logs = new Map<string, ExtensionLogEntry[]>();
  let seq = 0;
  const state: ExtensionStateApi = {
    get: async <T>(name: string) => documents.get(name) as T | undefined,
    set: async (name, value) => void documents.set(name, value),
    update: async <T>(name: string, fn: (current: T | undefined) => T | Promise<T>) => {
      const next = await fn(documents.get(name) as T | undefined);
      if (next === undefined) throw new Error(`update of ${name} returned undefined`);
      documents.set(name, next);
      return next;
    },
    delete: async (name) => documents.delete(name),
    list: async () => [...documents.keys()].sort(),
    importOnce: async <T>(name: string, make: () => T | undefined | Promise<T | undefined>) => {
      if (documents.has(name)) return documents.get(name) as T;
      const made = await make();
      if (made !== undefined) documents.set(name, made);
      return made;
    },
    append: async (name, entry) => {
      seq += 1;
      logs.set(name, [...(logs.get(name) ?? []), { seq, at: Date.now(), entry }]);
      return seq;
    },
    read: async <T>(name: string, options: ExtensionLogRead = {}) => {
      const kept = (logs.get(name) ?? []).filter(
        (each) => each.seq > (options.after ?? 0) && each.at >= (options.since ?? 0),
      );
      const limited = options.limit === undefined ? kept : kept.slice(-options.limit);
      return limited as ExtensionLogEntry<T>[];
    },
  };
  return { state, documents, logs };
}

/** What the extension did with the fake api, to look at in a test. */
export type FakeApi = {
  api: ExtensionApi;
  /** The tools of the last `tools.register`. */
  tools: () => ExtensionTool[];
  /** Calls one registered tool the way a session would; the pick card answers `pick`. */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    pick?: ExtensionPickAnswer,
  ) => Promise<string>;
  shown: { bySession: Record<string, Decoration[]>; statusBar: Decoration[] }[];
  flags: Map<string, LauncherFlag | null>;
  notices: { text: string; tone: string | undefined; session: string | undefined }[];
  /** Every URL the extension asked `api.openUrl` to open. */
  opened: string[];
  logs: { event: string; fields: Record<string, unknown> | undefined }[];
  /** Every card `api.confirm` asked the reader on, with the session it was asked from. */
  confirms: (ConfirmSpec & { session: string | null })[];
  /** Every line `api.status` was given, the latest last. */
  statuses: string[];
  /** What `api.state` holds. */
  documents: Map<string, unknown>;
};

/**
 * A fake `api`; parts left out of `options` are prifly's quiet defaults.
 * `confirm` is what the reader answers every `api.confirm` card: Confirm
 * (true, the default) or Cancel (false).
 */
export function fakeApi(
  options: {
    connections?: ExtensionConnectionsApi;
    settings?: SettingValues;
    folder?: string;
    confirm?: boolean;
  } = {},
): FakeApi {
  let tools: ExtensionTool[] = [];
  let scratchpad: string | undefined;
  /** The session of the tool call running now, as prifly knows it for `api.confirm`. */
  let calling: string | null = null;
  const { state, documents } = fakeState();
  const fake: Omit<FakeApi, "api" | "tools" | "callTool"> = {
    shown: [],
    flags: new Map(),
    notices: [],
    opened: [],
    logs: [],
    confirms: [],
    statuses: [],
    documents,
  };
  const api: ExtensionApi = {
    features: [
      "settings",
      "start-session",
      "session-lookup",
      "open-url",
      "tool-scratchpad",
      "state",
      "confirm",
      "status",
    ],
    state,
    confirm: async (spec) => {
      fake.confirms.push({ ...spec, session: spec.sessionId ?? calling });
      return options.confirm ?? true;
    },
    status: (text) => void fake.statuses.push(text),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.connections === undefined ? {} : { connections: options.connections }),
    tools: {
      register: (given) => {
        tools = given;
      },
    },
    show: (bySession, statusBar) => void fake.shown.push({ bySession, statusBar }),
    snoozeOptions: () => undefined,
    flag: (launchId, flag) => void fake.flags.set(launchId, flag),
    notify: (text, notifyOptions) =>
      void fake.notices.push({ text, tone: notifyOptions?.tone, session: notifyOptions?.session }),
    openUrl: async (url) => {
      fake.opened.push(url);
      return true;
    },
    machines: { report: () => undefined },
    onAction: () => undefined,
    onRent: () => undefined,
    sessions: () => [],
    session: () => null,
    log: (event, fields) => void fake.logs.push({ event, fields }),
    folder: options.folder ?? process.cwd(),
    paths: [],
    cloud: { sessions: async () => [], transcript: async () => [] },
    accounts: () => [],
    prompt: async () => ({ delivered: false }),
    start: async () => ({ started: false, reason: "A fake api starts no session." }),
    snooze: () => undefined,
    dialog: async () => null,
  };
  const callTool: FakeApi["callTool"] = async (name, args, pick = null) => {
    const tool = tools.find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name} registered`);
    const ctx: ExtensionToolContext = {
      session: "fake-session",
      pick: async () => pick,
      signal: new AbortController().signal,
      // Made on first read, as prifly makes the session's: one folder per fake api.
      get scratchpad() {
        scratchpad ??= mkdtempSync(join(tmpdir(), "fake-scratchpad-"));
        return scratchpad;
      },
    };
    calling = ctx.session;
    try {
      return await tool.call(args, ctx);
    } finally {
      calling = null;
    }
  };
  return { api, tools: () => tools, callTool, ...fake };
}
