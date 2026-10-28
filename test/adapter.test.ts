/**
 * The real SDK adapter (`atproto-agent.ts`) and the pacing in `client.ts`,
 * run against a fake `fetch` standing in for Bluesky's servers: nothing
 * leaves the process.
 */

import { afterEach, expect, test } from "bun:test";
import { createAtprotoAgent } from "../atproto-agent";
import { type Harness, harness } from "./harness";

const NOW = 1_800_000_000_000;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT the SDK can decode: header, payload with an expiry far ahead, signature. */
function jwt(): string {
  return `${b64url({ alg: "none" })}.${b64url({ exp: 4_000_000_000, scope: "com.atproto.appPass" })}.sig`;
}

type Seen = { path: string; method: string; headers: Headers; body: unknown };

type Server = {
  seen: Seen[];
  fetch: typeof globalThis.fetch;
  /** Answers for a request path (the NSID); the default is `{}` with status 200. */
  on: Record<string, (seen: Seen) => Response>;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function server(): Server {
  const state: Server = {
    seen: [],
    on: {},
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        // The SDK hands fetch one Request; a test of a plain call would use a URL and init.
        const request =
          input instanceof Request
            ? input
            : new Request(typeof input === "string" ? input : input.href, init);
        const url = new URL(request.url);
        const text = await request.clone().text();
        const seen: Seen = {
          path: url.pathname.replace("/xrpc/", ""),
          method: request.method,
          headers: request.headers,
          body: text === "" ? undefined : JSON.parse(text),
        };
        state.seen.push(seen);
        return state.on[seen.path]?.(seen) ?? json({});
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch,
  };
  state.on["com.atproto.server.createSession"] = () =>
    json({ accessJwt: jwt(), refreshJwt: jwt(), handle: "me.bsky.social", did: "did:plc:me" });
  return state;
}

let current: Harness | undefined;
afterEach(() => current?.stop());

async function setup(fake: Server, sleeps: number[] = [], minGapMs = 0): Promise<Harness> {
  current = await harness({
    makeAgent: (hooks) => createAtprotoAgent(hooks, { fetch: fake.fetch }),
    pacing: {
      minGapMs,
      now: () => NOW,
      sleep: async (ms) => void sleeps.push(ms),
    },
  });
  return current;
}

test("login sends the handle and app password to createSession", async () => {
  const fake = server();
  fake.on["app.bsky.feed.getTimeline"] = () => json({ feed: [] });
  const h = await setup(fake);
  expect(await h.call("bluesky_timeline")).toBe("No posts in your home timeline.");
  expect(fake.seen[0]).toMatchObject({
    path: "com.atproto.server.createSession",
    method: "POST",
    body: { identifier: "me.bsky.social", password: "abcd-efgh-ijkl-mnop" },
  });
  expect(fake.seen[1]?.headers.get("authorization")).toBe(`Bearer ${jwt()}`);
});

test("a wrong password (401 AuthenticationRequired) becomes the wrong-password message", async () => {
  const fake = server();
  fake.on["com.atproto.server.createSession"] = () =>
    json({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401);
  const h = await setup(fake);
  await expect(h.call("bluesky_timeline")).rejects.toThrow("the handle or app password is wrong");
});

test("a 429 with ratelimit-reset says when to retry", async () => {
  const fake = server();
  fake.on["app.bsky.feed.getTimeline"] = () =>
    json({ error: "RateLimitExceeded", message: "Rate Limit Exceeded" }, 429, {
      "ratelimit-reset": String(NOW / 1000 + 45),
    });
  const h = await setup(fake);
  const message = await h.call("bluesky_timeline").catch((e: Error) => e.message);
  expect(message).toContain("Try again in about 45 seconds (after ");
});

test("requests are paced by the minimum gap", async () => {
  const fake = server();
  fake.on["app.bsky.feed.getTimeline"] = () => json({ feed: [] });
  const sleeps: number[] = [];
  const h = await setup(fake, sleeps, 300);
  await h.call("bluesky_timeline");
  await h.call("bluesky_timeline");
  // createSession, then two timelines: the 2nd and 3rd wait out the gap after the one before.
  expect(sleeps).toEqual([300, 600]);
});

test("with no requests left, the next one waits for the rate-limit reset", async () => {
  const fake = server();
  fake.on["app.bsky.feed.getTimeline"] = () =>
    json({ feed: [] }, 200, {
      "ratelimit-remaining": "0",
      "ratelimit-reset": String(NOW / 1000 + 5),
    });
  const sleeps: number[] = [];
  const h = await setup(fake, sleeps);
  await h.call("bluesky_timeline");
  await h.call("bluesky_timeline");
  expect(sleeps).toEqual([5000]);
});

test("a rate-limit reset too far ahead is reported, not waited for", async () => {
  const fake = server();
  fake.on["app.bsky.feed.getTimeline"] = () =>
    json({ feed: [] }, 200, {
      "ratelimit-remaining": "0",
      "ratelimit-reset": String(NOW / 1000 + 600),
    });
  const sleeps: number[] = [];
  const h = await setup(fake, sleeps);
  await h.call("bluesky_timeline");
  const message = await h.call("bluesky_timeline").catch((e: Error) => e.message);
  expect(message).toStartWith("Bluesky's rate limit was reached.");
  expect(message).toContain("Try again in about 10 minutes");
  expect(message).not.toContain("network error");
  expect(sleeps).toEqual([]);
});

test("a direct message goes through the chat service with the atproto-proxy header", async () => {
  const fake = server();
  fake.on["com.atproto.identity.resolveHandle"] = () =>
    json({ did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz" });
  fake.on["chat.bsky.convo.getConvoForMembers"] = () =>
    json({ convo: { id: "convo9", rev: "1", members: [], muted: false, unreadCount: 0 } });
  fake.on["chat.bsky.convo.sendMessage"] = () =>
    json({
      id: "msg9",
      rev: "1",
      text: "hello",
      sender: { did: "did:plc:me" },
      sentAt: "2026-10-28T00:00:00.000Z",
    });
  const h = await setup(fake);
  expect(await h.call("bluesky_dm", { handle: "ada.bsky.social", text: "hello" })).toBe(
    "Sent your message to @ada.bsky.social.",
  );
  const chat = fake.seen.filter((s) => s.path.startsWith("chat.bsky.convo."));
  expect(chat.map((s) => s.path)).toEqual([
    "chat.bsky.convo.getConvoForMembers",
    "chat.bsky.convo.sendMessage",
  ]);
  for (const request of chat) {
    expect(request.headers.get("atproto-proxy")).toBe("did:web:api.bsky.chat#bsky_chat");
  }
  expect(chat[1]?.body).toEqual({ convoId: "convo9", message: { text: "hello" } });
  // Everything else is not proxied.
  expect(
    fake.seen
      .find((s) => s.path === "com.atproto.identity.resolveHandle")
      ?.headers.get("atproto-proxy"),
  ).toBeNull();
});

test("a reply creates a post record with root and parent set", async () => {
  const fake = server();
  const parentUri = "at://did:plc:oisofpd7lkhxfcbqsvjtpzuw/app.bsky.feed.post/p1";
  fake.on["app.bsky.feed.getPosts"] = () =>
    json({
      posts: [
        {
          uri: parentUri,
          cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
          author: { did: "did:plc:oisofpd7lkhxfcbqsvjtpzuw", handle: "bob.bsky.social" },
          record: { text: "parent", createdAt: "2026-10-28T00:00:00.000Z" },
          indexedAt: "2026-10-28T00:00:00.000Z",
        },
      ],
    });
  fake.on["com.atproto.repo.createRecord"] = () =>
    json({
      uri: "at://did:plc:me/app.bsky.feed.post/new",
      cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
    });
  const h = await setup(fake);
  const out = await h.call("bluesky_reply", { replyTo: parentUri, text: "agreed" });
  expect(out).toContain("Replied. at://did:plc:me/app.bsky.feed.post/new");
  const created = fake.seen.find((s) => s.path === "com.atproto.repo.createRecord");
  expect(created?.body).toMatchObject({
    repo: "did:plc:me",
    collection: "app.bsky.feed.post",
    record: {
      $type: "app.bsky.feed.post",
      text: "agreed",
      reply: {
        root: {
          uri: parentUri,
          cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
        },
        parent: {
          uri: parentUri,
          cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
        },
      },
    },
  });
});
