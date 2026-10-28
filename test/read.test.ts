import { afterEach, expect, test } from "bun:test";
import { feedItem, type Harness, harness, ME, notification, post, xrpcError } from "./harness";

let current: Harness | undefined;
afterEach(() => current?.stop());

async function setup(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  current = await harness(options);
  return current;
}

test("activate registers all eight tools", async () => {
  const h = await setup();
  expect(h.tools().map((tool) => tool.name)).toEqual([
    "bluesky_timeline",
    "bluesky_notifications",
    "bluesky_thread",
    "bluesky_profile",
    "bluesky_search",
    "bluesky_post",
    "bluesky_reply",
    "bluesky_dm",
  ]);
  expect(h.statuses).toEqual(["Bluesky as @me.bsky.social"]);
});

test("timeline: posts as Markdown with author, time, counts, URI, link and the next cursor", async () => {
  const h = await setup({
    script: {
      getTimeline: async () => ({
        items: [
          feedItem(1, { text: "First line\nSecond line" }),
          {
            post: post(2, { handle: "bob.bsky.social", name: "Bob" }),
            reason: { $type: "app.bsky.feed.defs#reasonRepost", by: post(3).author },
          },
        ],
        cursor: "next123",
      }),
    },
  });
  const text = await h.call("bluesky_timeline", { cursor: "c0", limit: 10 });
  expect(text).toContain("**User 1** @user1.bsky.social · 2026-10-28 12:30 UTC");
  expect(text).toContain("> First line\n> Second line");
  expect(text).toContain("3 likes · 1 repost · 2 replies · 0 quotes");
  expect(text).toContain(
    "at://did:plc:user1/app.bsky.feed.post/rkey1 · https://bsky.app/profile/user1.bsky.social/post/rkey1",
  );
  expect(text).toContain("Reposted by **User 3** @user3.bsky.social");
  expect(text).toContain("Next page: call bluesky_timeline again with cursor `next123`.");
  expect(h.agent.calls.find((c) => c.method === "getTimeline")?.args).toEqual([
    { cursor: "c0", limit: 10 },
  ]);
});

test("timeline: the last page says there are no more", async () => {
  const h = await setup({ script: { getTimeline: async () => ({ items: [feedItem(1)] }) } });
  expect(await h.call("bluesky_timeline")).toContain("No more pages.");
});

test("an empty timeline, notifications and search say so, not an empty string", async () => {
  const h = await setup();
  expect(await h.call("bluesky_timeline")).toBe("No posts in your home timeline.");
  expect(await h.call("bluesky_notifications")).toBe("No notifications.");
  expect(await h.call("bluesky_search", { query: "zebra" })).toBe('No posts found for "zebra".');
});

test("notifications: likes, replies and follows with the post links", async () => {
  const h = await setup({
    script: {
      listNotifications: async () => ({
        items: [
          notification(1, "like", { reasonSubject: "at://did:plc:me/app.bsky.feed.post/mine1" }),
          notification(2, "reply", {
            uri: "at://did:plc:user2/app.bsky.feed.post/reply2",
            record: { text: "Nice one" },
          }),
          notification(3, "follow", { isRead: true }),
        ],
        cursor: "n2",
      }),
    },
  });
  const text = await h.call("bluesky_notifications");
  expect(text).toContain("**User 1** @user1.bsky.social liked your post");
  expect(text).toContain(
    "On: at://did:plc:me/app.bsky.feed.post/mine1 · https://bsky.app/profile/did:plc:me/post/mine1",
  );
  expect(text).toContain("replied to you");
  expect(text).toContain("  > Nice one");
  expect(text).toContain(
    "at://did:plc:user2/app.bsky.feed.post/reply2 · https://bsky.app/profile/user2.bsky.social/post/reply2",
  );
  expect(text).toContain("followed you");
  expect(text).toContain("cursor `n2`");
});

test("thread: a bsky.app link is turned into the at:// URI; parents and replies are shown", async () => {
  const h = await setup({
    script: {
      getPostThread: async () => ({
        post: post(2, { text: "the post" }),
        parent: { post: post(1, { text: "the parent" }) },
        replies: [
          { post: post(3, { text: "a reply" }), replies: [{ post: post(4, { text: "nested" }) }] },
          { $type: "app.bsky.feed.defs#notFoundPost" },
        ],
      }),
    },
  });
  const text = await h.call("bluesky_thread", {
    post: "https://bsky.app/profile/user2.bsky.social/post/rkey2?x=1",
  });
  expect(h.agent.calls.find((c) => c.method === "resolveHandle")?.args).toEqual([
    "user2.bsky.social",
  ]);
  expect(h.agent.calls.find((c) => c.method === "getPostThread")?.args).toEqual([
    { uri: "at://did:plc:user2/app.bsky.feed.post/rkey2", depth: 4, parentHeight: 10 },
  ]);
  expect(text.indexOf("the parent")).toBeLessThan(text.indexOf("the post"));
  expect(text).toContain("### Replies");
  expect(text).toContain("- **User 3**");
  expect(text).toContain("  - **User 4**");
  expect(text).toContain("(deleted or unavailable post)");
});

test("thread: an at:// URI is used as it is, with no handle lookup", async () => {
  const h = await setup();
  const uri = "at://did:plc:abc/app.bsky.feed.post/xyz";
  await h.call("bluesky_thread", { post: uri });
  expect(h.agent.calls.map((c) => c.method)).toEqual(["login", "getPostThread"]);
  expect(h.agent.calls[1]?.args).toEqual([{ uri, depth: 4, parentHeight: 10 }]);
});

test("thread: a link that is not a post is refused before anything is asked of Bluesky", async () => {
  const h = await setup();
  await expect(h.call("bluesky_thread", { post: "https://example.com/a" })).rejects.toThrow(
    "is not a Bluesky post",
  );
});

test("profile: defaults to the reader, and shows name, bio and counts", async () => {
  const h = await setup({
    script: {
      getProfile: async (actor) => ({
        did: "did:plc:me",
        handle: actor,
        displayName: "Me Myself",
        description: "Likes tests\nand cats",
        followersCount: 12,
        followsCount: 34,
        postsCount: 1,
        createdAt: "2024-01-02T03:04:05.000Z",
      }),
    },
  });
  const text = await h.call("bluesky_profile");
  expect(h.agent.calls.find((c) => c.method === "getProfile")?.args).toEqual(["me.bsky.social"]);
  expect(text).toContain("## Me Myself (@me.bsky.social)");
  expect(text).toContain("> Likes tests\n> and cats");
  expect(text).toContain("12 followers · 34 following · 1 post");
  expect(text).toContain("https://bsky.app/profile/me.bsky.social");
  await h.call("bluesky_profile", { actor: "@Ada.bsky.social" });
  expect(h.agent.calls.filter((c) => c.method === "getProfile").at(-1)?.args).toEqual([
    "ada.bsky.social",
  ]);
});

test("search: posts, total, and a cursor for the next page", async () => {
  const h = await setup({
    script: {
      searchPosts: async () => ({
        items: [post(1, { text: "zebra crossing" })],
        cursor: "s2",
        total: 40,
      }),
    },
  });
  const text = await h.call("bluesky_search", { query: "zebra", sort: "top", cursor: "s1" });
  expect(text).toContain('## Search: "zebra" (1 of about 40 posts)');
  expect(text).toContain("> zebra crossing");
  expect(text).toContain("cursor `s2`");
  expect(h.agent.calls.find((c) => c.method === "searchPosts")?.args).toEqual([
    { q: "zebra", cursor: "s1", limit: 20, sort: "top" },
  ]);
  await expect(h.call("bluesky_search", {})).rejects.toThrow("query is required");
});

test("the session logs in once and is reused", async () => {
  const h = await setup();
  await h.call("bluesky_timeline");
  await h.call("bluesky_notifications");
  expect(h.agent.calls.filter((c) => c.method === "login")).toEqual([
    { method: "login", args: [ME.handle, "abcd-efgh-ijkl-mnop"] },
  ]);
});

test("not signed in: no app password says exactly how to add it", async () => {
  const h = await setup({ password: null });
  const error = await h.call("bluesky_timeline").catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("Not signed in to Bluesky: no app password is in the vault");
  expect(message).toContain("https://bsky.app/settings/app-passwords");
  expect(message).toContain('Settings -> Vault and add an API token named "bluesky"');
  expect(message).toContain("Settings -> Extensions -> Bluesky");
  expect(h.agent.calls).toEqual([]);
});

test("not signed in: no handle is told apart from no password", async () => {
  const h = await setup({ handle: "" });
  await expect(h.call("bluesky_timeline")).rejects.toThrow("no handle is set");
});

test("wrong password: says the handle or app password is wrong, and tries again on the next call", async () => {
  let fail = true;
  const h = await setup({
    script: {
      login: async () => {
        if (fail) throw xrpcError(401, "AuthenticationRequired", "Invalid identifier or password");
        return ME;
      },
      getTimeline: async () => ({ items: [feedItem(1)] }),
    },
  });
  await expect(h.call("bluesky_timeline")).rejects.toThrow("the handle or app password is wrong");
  fail = false;
  expect(await h.call("bluesky_timeline")).toContain("User 1");
});

test("an expired session logs in again once and retries", async () => {
  let timelineCalls = 0;
  const h = await setup({
    script: {
      getTimeline: async () => {
        timelineCalls += 1;
        if (timelineCalls === 1) throw xrpcError(400, "ExpiredToken", "Token has expired");
        return { items: [feedItem(1)] };
      },
    },
  });
  expect(await h.call("bluesky_timeline")).toContain("User 1");
  expect(h.agent.calls.map((c) => c.method)).toEqual([
    "login",
    "getTimeline",
    "login",
    "getTimeline",
  ]);
});

test("a session that stays refused is reported after one re-login, not retried forever", async () => {
  const h = await setup({
    script: {
      getTimeline: async () => {
        throw xrpcError(401, "AuthenticationRequired", "Authentication Required");
      },
    },
  });
  await expect(h.call("bluesky_timeline")).rejects.toThrow("kept refusing the session");
  expect(h.agent.calls.filter((c) => c.method === "login")).toHaveLength(2);
  expect(h.agent.calls.filter((c) => c.method === "getTimeline")).toHaveLength(2);
});

test("rate limit: says when to retry", async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  const h = await setup({
    script: {
      getTimeline: async () => {
        throw xrpcError(429, "RateLimitExceeded", "Rate Limit Exceeded", {
          "ratelimit-reset": String(reset),
        });
      },
    },
  });
  const message = await h.call("bluesky_timeline").catch((e: Error) => e.message);
  expect(message).toMatch(/rate limit was reached\. Try again in about 2 minutes/);
});

test("network error: a message that says Bluesky could not be reached", async () => {
  const h = await setup({
    script: {
      getTimeline: async () => {
        throw new TypeError("fetch failed");
      },
    },
  });
  await expect(h.call("bluesky_timeline")).rejects.toThrow(
    "Could not reach Bluesky (network error: fetch failed)",
  );
});

test("a server error is reported with its status", async () => {
  const h = await setup({
    script: {
      getTimeline: async () => {
        throw xrpcError(502, "UpstreamFailure", "bad gateway");
      },
    },
  });
  await expect(h.call("bluesky_timeline")).rejects.toThrow("answered 502");
});
