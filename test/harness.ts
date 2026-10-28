/**
 * Test fakes: a fake AT Protocol agent (`AgentLike`) that records its calls
 * and answers from a script, post builders, and `harness`, which activates the
 * extension over prifly's fake api with that agent, a vault holding the app
 * password and the handle setting. No network, no process.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { activate, type Options } from "../index";
import type { AgentLike, FeedItem, Notification, PostView } from "../types";
import { fakeApi } from "./fake-api";

/** An error as the SDK throws it (an XRPCError): status, error name, headers. */
export function xrpcError(
  status: number,
  error: string,
  message = error,
  headers: Record<string, string> = {},
): Error {
  return Object.assign(new Error(message), { status, error, headers });
}

export const ME = { did: "did:plc:me", handle: "me.bsky.social" };

export function post(
  n: number,
  over: Partial<PostView> & { text?: string; handle?: string; name?: string } = {},
): PostView {
  const handle = over.handle ?? `user${n}.bsky.social`;
  const { text, handle: _h, name, ...rest } = over;
  return {
    uri: `at://did:plc:user${n}/app.bsky.feed.post/rkey${n}`,
    cid: `cid${n}`,
    author: { did: `did:plc:user${n}`, handle, displayName: name ?? `User ${n}` },
    record: { text: text ?? `Hello from ${n}`, createdAt: "2026-10-28T12:30:00.000Z" },
    indexedAt: "2026-10-28T12:30:01.000Z",
    likeCount: 3,
    repostCount: 1,
    replyCount: 2,
    quoteCount: 0,
    ...rest,
  };
}

export function feedItem(n: number, over: Parameters<typeof post>[1] = {}): FeedItem {
  return { post: post(n, over) };
}

export function notification(
  n: number,
  reason: string,
  over: Partial<Notification> = {},
): Notification {
  return {
    uri: `at://did:plc:user${n}/app.bsky.feed.like/like${n}`,
    cid: `ncid${n}`,
    author: { did: `did:plc:user${n}`, handle: `user${n}.bsky.social`, displayName: `User ${n}` },
    reason,
    record: {},
    isRead: false,
    indexedAt: "2026-10-28T13:00:00.000Z",
    ...over,
  };
}

export type FakeAgent = AgentLike & { calls: { method: string; args: unknown[] }[] };

/** An agent answering from `script`; every call is recorded in `calls`. A method not scripted answers an empty page. */
export function fakeAgent(script: Partial<AgentLike> = {}): FakeAgent {
  const calls: FakeAgent["calls"] = [];
  const defaults: AgentLike = {
    login: async () => ME,
    getTimeline: async () => ({ items: [] }),
    listNotifications: async () => ({ items: [] }),
    getPostThread: async () => ({ post: post(1) }),
    getProfile: async (actor) => ({ did: "did:plc:x", handle: actor }),
    searchPosts: async () => ({ items: [] }),
    getPosts: async (uris) => uris.map((_, i) => post(i + 1)),
    resolveHandle: async (handle) => `did:plc:${handle.split(".")[0]}`,
    createPost: async () => ({
      uri: "at://did:plc:me/app.bsky.feed.post/new1",
      cid: "newcid",
    }),
    sendDirectMessage: async () => ({ convoId: "convo1", messageId: "msg1" }),
  };
  const merged = { ...defaults, ...script };
  const agent = {} as AgentLike;
  for (const name of Object.keys(merged) as (keyof AgentLike)[]) {
    const fn = merged[name] as (...args: unknown[]) => Promise<unknown>;
    (agent as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      calls.push({ method: name, args });
      return await fn(...args);
    };
  }
  return Object.assign(agent, { calls });
}

export type Harness = ReturnType<typeof fakeApi> & {
  agent: FakeAgent;
  /** Calls a tool; the text it answers, or the error it throws. */
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  stop: () => void;
  made: { agents: number };
};

export async function harness(
  options: {
    script?: Partial<AgentLike>;
    confirm?: boolean;
    handle?: string;
    password?: string | null;
    pacing?: Options["pacing"];
    makeAgent?: Options["makeAgent"];
  } = {},
): Promise<Harness> {
  const agent = fakeAgent(options.script);
  const fake = fakeApi({
    settings: { handle: options.handle ?? ME.handle },
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  const password = options.password === undefined ? "abcd-efgh-ijkl-mnop" : options.password;
  const api: ExtensionApi = fake.api;
  api.vault = { read: async (name) => (name === "bluesky" ? password : null) };
  const made = { agents: 0 };
  const stop = activate(api, {
    makeAgent:
      options.makeAgent ??
      (() => {
        made.agents += 1;
        return agent;
      }),
    pacing: options.pacing ?? { minGapMs: 0, sleep: async () => undefined },
  });
  return { ...fake, agent, call: (name, args = {}) => fake.callTool(name, args), stop, made };
}
