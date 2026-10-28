import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANCELLED, CANNOT_ASK } from "../write-tools";
import { type Harness, harness, post, xrpcError } from "./harness";

let current: Harness | undefined;
afterEach(() => current?.stop());

async function setup(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  current = await harness(options);
  return current;
}

const sent = (h: Harness, method: string) => h.agent.calls.filter((c) => c.method === method);

/** The post the extension asked the agent to create. */
function created(h: Harness): { facets?: unknown; reply?: unknown } {
  const call = sent(h, "createPost")[0];
  if (call === undefined) throw new Error("no post was created");
  return call.args[0] as { facets?: unknown; reply?: unknown };
}

test("post: the card shows the exact text, and the post is sent on Confirm", async () => {
  const h = await setup();
  const text = await h.call("bluesky_post", { text: "Hello Bluesky" });
  expect(text).toBe(
    "Posted. at://did:plc:me/app.bsky.feed.post/new1\nhttps://bsky.app/profile/me.bsky.social/post/new1",
  );
  expect(h.confirms).toHaveLength(1);
  expect(h.confirms[0]).toMatchObject({
    title: "Post on Bluesky",
    summary: "Post on Bluesky as @me.bsky.social",
    content: "Hello Bluesky",
    session: "fake-session",
  });
  expect(h.confirms[0]?.details).toContain("Length: 13 of 300");
  expect(sent(h, "createPost")[0]?.args).toEqual([
    { text: "Hello Bluesky", facets: undefined, reply: undefined, images: [] },
  ]);
});

test('post: cancelling answers exactly "Not done: you cancelled" and sends nothing', async () => {
  const h = await setup({ confirm: false });
  expect(await h.call("bluesky_post", { text: "Hello" })).toBe("Not done: you cancelled");
  expect(CANCELLED).toBe("Not done: you cancelled");
  expect(h.confirms).toHaveLength(1);
  expect(sent(h, "createPost")).toEqual([]);
});

test("post: a prifly that cannot ask first sends nothing", async () => {
  const h = await setup();
  delete (h.api as { confirm?: unknown }).confirm;
  expect(await h.call("bluesky_post", { text: "Hello" })).toBe(CANNOT_ASK);
  expect(sent(h, "createPost")).toEqual([]);
});

test("post: not signed in fails before any card", async () => {
  const h = await setup({ password: null });
  await expect(h.call("bluesky_post", { text: "Hello" })).rejects.toThrow("Not signed in");
  expect(h.confirms).toEqual([]);
});

test("post: links and mentions become facets, and the card lists them", async () => {
  const h = await setup();
  await h.call("bluesky_post", { text: "hi @ada.bsky.social see https://example.com/x ok" });
  const details = h.confirms[0]?.details ?? "";
  expect(details).toContain("Links: https://example.com/x");
  expect(details).toContain("Mentions: @ada.bsky.social (did:plc:ada)");
  const request = sent(h, "createPost")[0]?.args[0] as {
    facets: { features: { $type: string }[] }[];
  };
  expect(request.facets.map((f) => f.features[0]?.$type)).toEqual([
    "app.bsky.richtext.facet#mention",
    "app.bsky.richtext.facet#link",
  ]);
});

test("post: a mention of no account stays plain text", async () => {
  const h = await setup({
    script: {
      resolveHandle: async () => {
        throw xrpcError(400, "InvalidRequest", "Unable to resolve handle");
      },
    },
  });
  await h.call("bluesky_post", { text: "hi @nobody.example.com" });
  expect(h.confirms[0]?.details).toContain("Not accounts, left as plain text: @nobody.example.com");
  expect(created(h).facets).toBeUndefined();
});

test("post: over 300 graphemes is refused with a clear error before the card", async () => {
  const h = await setup();
  const error = await h.call("bluesky_post", { text: "a".repeat(301) }).catch((e: Error) => e);
  expect((error as Error).message).toBe(
    "Too long for Bluesky: the post is 301 characters (graphemes) and the limit is 300; shorten it by 1. Nothing was sent.",
  );
  expect(h.confirms).toEqual([]);
  expect(h.agent.calls).toEqual([]);
});

test("post: the limit counts graphemes, not UTF-16 units or bytes", async () => {
  const h = await setup();
  const family = "👨‍👩‍👧";
  expect(family.length).toBeGreaterThan(1);
  await h.call("bluesky_post", { text: family.repeat(300) });
  expect(h.confirms).toHaveLength(1);
  await expect(h.call("bluesky_post", { text: family.repeat(301) })).rejects.toThrow("Too long");
});

test("post: empty text is refused", async () => {
  const h = await setup();
  await expect(h.call("bluesky_post", { text: "   " })).rejects.toThrow("text is required");
});

function picture(name: string, bytes = 10): string {
  const dir = mkdtempSync(join(tmpdir(), "bsky-test-"));
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array(bytes).fill(7));
  return path;
}

test("post: images are read, shown on the card by file name with alt text, and uploaded", async () => {
  const h = await setup();
  const path = picture("cat.png");
  await h.call("bluesky_post", { text: "my cat", images: [{ path, alt: "A grey cat" }] });
  expect(h.confirms[0]?.summary).toContain("with 1 image (cat.png)");
  expect(h.confirms[0]?.details).toContain("Image 1: cat.png");
  expect(h.confirms[0]?.details).toContain('alt text: "A grey cat"');
  const request = sent(h, "createPost")[0]?.args[0] as {
    images: { bytes: Uint8Array; mime: string; alt: string }[];
  };
  expect(request.images).toHaveLength(1);
  expect(request.images[0]).toMatchObject({ mime: "image/png", alt: "A grey cat" });
  expect(request.images[0]?.bytes.length).toBe(10);
});

test("post: more than 4 images is refused before the card", async () => {
  const h = await setup();
  const path = picture("a.jpg");
  const images = Array.from({ length: 5 }, () => ({ path, alt: "x" }));
  await expect(h.call("bluesky_post", { text: "too many", images })).rejects.toThrow(
    "at most 4 images in a post; 5 were given",
  );
  expect(h.confirms).toEqual([]);
});

test("post: a relative path, a wrong type and a missing or huge file are refused before the card", async () => {
  const h = await setup();
  await expect(
    h.call("bluesky_post", { text: "x", images: [{ path: "cat.png", alt: "" }] }),
  ).rejects.toThrow("local absolute path");
  await expect(
    h.call("bluesky_post", { text: "x", images: [{ path: picture("a.pdf"), alt: "" }] }),
  ).rejects.toThrow("not a JPEG, PNG, GIF or WebP");
  await expect(
    h.call("bluesky_post", {
      text: "x",
      images: [{ path: join(tmpdir(), "nope-missing.png"), alt: "" }],
    }),
  ).rejects.toThrow("Cannot read");
  await expect(
    h.call("bluesky_post", {
      text: "x",
      images: [{ path: picture("big.png", 1_000_001), alt: "" }],
    }),
  ).rejects.toThrow("takes images up to 1000000 bytes");
  expect(h.confirms).toEqual([]);
});

test("reply: the thread's root and the parent are set from the parent's own reply field", async () => {
  const parent = post(5, {
    handle: "bob.bsky.social",
    record: {
      text: "a middle post",
      reply: {
        root: { uri: "at://did:plc:root/app.bsky.feed.post/r0", cid: "rootcid" },
        parent: { uri: "at://did:plc:other/app.bsky.feed.post/p0", cid: "othercid" },
      },
    },
  });
  const h = await setup({ script: { getPosts: async () => [parent] } });
  const out = await h.call("bluesky_reply", {
    replyTo: "https://bsky.app/profile/bob.bsky.social/post/rkey5",
    text: "good point",
  });
  expect(out.startsWith("Replied. at://")).toBe(true);
  // The link names bob by handle; the fake resolves it to did:plc:bob.
  expect(sent(h, "getPosts")[0]?.args).toEqual([["at://did:plc:bob/app.bsky.feed.post/rkey5"]]);
  expect(sent(h, "createPost")[0]?.args[0]).toMatchObject({
    text: "good point",
    reply: {
      root: { uri: "at://did:plc:root/app.bsky.feed.post/r0", cid: "rootcid" },
      parent: { uri: parent.uri, cid: "cid5" },
    },
  });
  expect(h.confirms[0]).toMatchObject({
    title: "Reply on Bluesky",
    summary: "Reply to @bob.bsky.social's post on Bluesky as @me.bsky.social",
    content: "good point",
  });
  expect(h.confirms[0]?.details).toContain("https://bsky.app/profile/bob.bsky.social/post/rkey5");
  expect(h.confirms[0]?.details).toContain('"a middle post"');
});

test("reply: a reply to a top-level post has that post as both root and parent", async () => {
  const h = await setup();
  await h.call("bluesky_reply", {
    replyTo: "at://did:plc:user1/app.bsky.feed.post/rkey1",
    text: "hi",
  });
  const ref = { uri: "at://did:plc:user1/app.bsky.feed.post/rkey1", cid: "cid1" };
  expect(sent(h, "createPost")[0]?.args[0]).toMatchObject({ reply: { root: ref, parent: ref } });
});

test("reply: bluesky_post with replyTo is the same", async () => {
  const h = await setup();
  await h.call("bluesky_post", {
    text: "hi",
    replyTo: "at://did:plc:user1/app.bsky.feed.post/rkey1",
  });
  expect(created(h).reply).toBeDefined();
});

test("reply: cancelling sends nothing; a missing post is an error before the card", async () => {
  const h = await setup({ confirm: false });
  expect(
    await h.call("bluesky_reply", {
      replyTo: "at://did:plc:user1/app.bsky.feed.post/rkey1",
      text: "hi",
    }),
  ).toBe("Not done: you cancelled");
  expect(sent(h, "createPost")).toEqual([]);

  const gone = await setup({ script: { getPosts: async () => [] } });
  await expect(
    gone.call("bluesky_reply", { replyTo: "at://did:plc:x/app.bsky.feed.post/zzz", text: "hi" }),
  ).rejects.toThrow("No such post");
  expect(gone.confirms).toEqual([]);
});

test("reply: over 300 graphemes is refused", async () => {
  const h = await setup();
  await expect(
    h.call("bluesky_reply", {
      replyTo: "at://did:plc:u/app.bsky.feed.post/r",
      text: "b".repeat(350),
    }),
  ).rejects.toThrow("shorten it by 50");
});

test("dm: the card names the recipient, and the message goes to their DID on Confirm", async () => {
  const h = await setup();
  const out = await h.call("bluesky_dm", { handle: "@Ada.bsky.social", text: "Lunch tomorrow?" });
  expect(out).toBe("Sent your message to @ada.bsky.social.");
  expect(h.confirms[0]).toMatchObject({
    title: "Send a Bluesky message",
    summary: "Send a direct message to @ada.bsky.social",
    content: "Lunch tomorrow?",
  });
  expect(h.confirms[0]?.details).toContain("To: ada.bsky.social (did:plc:ada)");
  expect(sent(h, "sendDirectMessage")[0]?.args).toEqual([
    "did:plc:ada",
    "Lunch tomorrow?",
    undefined,
  ]);
});

test("dm: cancelling sends nothing", async () => {
  const h = await setup({ confirm: false });
  expect(await h.call("bluesky_dm", { handle: "ada.bsky.social", text: "hi" })).toBe(
    "Not done: you cancelled",
  );
  expect(sent(h, "sendDirectMessage")).toEqual([]);
});

test("dm: an account that does not exist is said so before the card", async () => {
  const h = await setup({
    script: {
      resolveHandle: async () => {
        throw xrpcError(400, "InvalidRequest", "Unable to resolve handle");
      },
    },
  });
  await expect(h.call("bluesky_dm", { handle: "ghost.bsky.social", text: "hi" })).rejects.toThrow(
    "There is no Bluesky account @ghost.bsky.social",
  );
  expect(h.confirms).toEqual([]);
});

test("dm: a message over 1000 graphemes is refused; an app password without chat access says what to do", async () => {
  const h = await setup({
    script: {
      sendDirectMessage: async () => {
        throw xrpcError(400, "InvalidToken", "Bad token scope");
      },
    },
  });
  await expect(
    h.call("bluesky_dm", { handle: "ada.bsky.social", text: "c".repeat(1001) }),
  ).rejects.toThrow("limit is 1000");
  await expect(h.call("bluesky_dm", { handle: "ada.bsky.social", text: "hi" })).rejects.toThrow(
    "Allow access to your direct messages",
  );
});
