/**
 * The slice of Bluesky's data this extension reads, and `AgentLike`: the few
 * calls it makes on an AT Protocol agent. The real agent (`atproto-agent.ts`,
 * from `@atproto/api`) implements `AgentLike`; tests give the tools a fake
 * one. The shapes are structural subsets of the SDK's own types, so what the
 * SDK returns fits them without a copy.
 */

import type { AppBskyRichtextFacet } from "@atproto/api";

export type Facet = AppBskyRichtextFacet.Main;

export type Author = {
  did: string;
  handle: string;
  displayName?: string | undefined;
};

export type PostView = {
  uri: string;
  cid: string;
  author: Author;
  /** The `app.bsky.feed.post` record: `text`, `reply`, `createdAt`... */
  record: unknown;
  indexedAt: string;
  likeCount?: number | undefined;
  repostCount?: number | undefined;
  replyCount?: number | undefined;
  quoteCount?: number | undefined;
  /** The post's embed as the AppView renders it (images, a link card, a quoted post). */
  embed?: unknown;
};

export type FeedItem = {
  post: PostView;
  /** Set for a repost (`by` is who reposted) or a pin. */
  reason?: { $type?: string | undefined; by?: Author | undefined } | undefined;
};

export type Notification = {
  uri: string;
  cid: string;
  author: Author;
  /** like, repost, follow, mention, reply, quote, starterpack-joined, verified... */
  reason: string;
  /** For a like or repost: the at:// URI of the post it was on. */
  reasonSubject?: string | undefined;
  record: unknown;
  isRead: boolean;
  indexedAt: string;
};

export type ThreadNode = {
  $type?: string | undefined;
  post?: PostView | undefined;
  parent?: ThreadNode | undefined;
  replies?: ThreadNode[] | undefined;
};

export type Profile = {
  did: string;
  handle: string;
  displayName?: string | undefined;
  description?: string | undefined;
  followersCount?: number | undefined;
  followsCount?: number | undefined;
  postsCount?: number | undefined;
  createdAt?: string | undefined;
  indexedAt?: string | undefined;
};

export type Page<T> = { items: T[]; cursor?: string | undefined };

/** An image to attach: its bytes and type are read before the reader is asked. */
export type NewImage = { bytes: Uint8Array; mime: string; alt: string };

export type PostRef = { uri: string; cid: string };

export type NewPost = {
  text: string;
  facets?: Facet[] | undefined;
  /** Set for a reply: the thread's first post and the post replied to. */
  reply?: { root: PostRef; parent: PostRef } | undefined;
  images?: NewImage[] | undefined;
};

export type Session = { did: string; handle: string };

/** Every call this extension makes on Bluesky. Errors are thrown as the SDK throws them. */
export type AgentLike = {
  login(identifier: string, password: string): Promise<Session>;
  getTimeline(params: { cursor?: string | undefined; limit: number }): Promise<Page<FeedItem>>;
  listNotifications(params: {
    cursor?: string | undefined;
    limit: number;
  }): Promise<Page<Notification>>;
  getPostThread(params: { uri: string; depth: number; parentHeight: number }): Promise<ThreadNode>;
  getProfile(actor: string): Promise<Profile>;
  searchPosts(params: {
    q: string;
    cursor?: string | undefined;
    limit: number;
    sort?: "top" | "latest" | undefined;
  }): Promise<Page<PostView> & { total?: number | undefined }>;
  getPosts(uris: string[]): Promise<PostView[]>;
  /** A handle's DID; throws when there is no such account. */
  resolveHandle(handle: string): Promise<string>;
  /** Uploads any images, then creates the post. */
  createPost(post: NewPost): Promise<PostRef>;
  /** Opens (or finds) the conversation with `did` and sends one message in it. */
  sendDirectMessage(
    did: string,
    text: string,
    facets: Facet[] | undefined,
  ): Promise<{ convoId: string; messageId: string }>;
};
