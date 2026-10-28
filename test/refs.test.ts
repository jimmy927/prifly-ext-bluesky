import { expect, test } from "bun:test";
import { graphemeLength, parseActor, parsePostName, postUrl } from "../refs";

test("a bsky.app link names a post by handle or DID; query, hash and slash are ignored", () => {
  expect(parsePostName("https://bsky.app/profile/Ada.bsky.social/post/3kabc")).toEqual({
    authority: "ada.bsky.social",
    rkey: "3kabc",
  });
  expect(parsePostName("  https://bsky.app/profile/did:plc:xyz/post/3kabc/?ref=1#top ")).toEqual({
    authority: "did:plc:xyz",
    rkey: "3kabc",
  });
  expect(parsePostName("https://staging.bsky.app/profile/a.b/post/z")).toEqual({
    authority: "a.b",
    rkey: "z",
  });
});

test("an at:// URI names a post", () => {
  expect(parsePostName("at://did:plc:xyz/app.bsky.feed.post/3kabc")).toEqual({
    authority: "did:plc:xyz",
    rkey: "3kabc",
  });
});

test("anything else is refused with the two accepted forms", () => {
  for (const input of [
    "",
    "hello",
    "https://example.com/profile/a/post/b",
    "https://bsky.app/profile/a.bsky.social",
    "https://bsky.app/profile/a/feed/b",
    "at://did:plc:xyz/app.bsky.feed.like/3k",
  ]) {
    expect(() => parsePostName(input)).toThrow("is not a Bluesky post");
  }
});

test("an actor may be a handle, an @handle, a DID or a profile link", () => {
  expect(parseActor("@Ada.bsky.social")).toBe("ada.bsky.social");
  expect(parseActor("did:plc:abc")).toBe("did:plc:abc");
  expect(parseActor("https://bsky.app/profile/ada.bsky.social")).toBe("ada.bsky.social");
});

test("postUrl is the bsky.app link of an at:// URI", () => {
  expect(postUrl("at://did:plc:x/app.bsky.feed.post/3k", "ada.bsky.social")).toBe(
    "https://bsky.app/profile/ada.bsky.social/post/3k",
  );
});

test("graphemes: an emoji sequence is one, and so is a combining accent", () => {
  expect(graphemeLength("👨‍👩‍👧")).toBe(1);
  expect(graphemeLength("é")).toBe(1);
  expect(graphemeLength("abc")).toBe(3);
});
