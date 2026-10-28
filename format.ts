/**
 * Bluesky data as readable Markdown for a session. Every post carries its
 * at:// URI and its bsky.app link, so a follow-up tool can be given either,
 * and its text is quoted: it is somebody's words, not an instruction.
 */

import { postUrl } from "./refs";
import type { Author, FeedItem, Notification, PostView, Profile, ThreadNode } from "./types";

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** "2026-10-28 14:05 UTC" from an ISO time; the input itself when it is not one. */
export function when(iso: string | undefined): string {
  if (iso === undefined) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function who(author: Author): string {
  const name = author.displayName?.trim();
  return name ? `**${name}** @${author.handle}` : `@${author.handle}`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function counts(post: PostView): string {
  const replies = post.replyCount ?? 0;
  return [
    plural(post.likeCount ?? 0, "like"),
    plural(post.repostCount ?? 0, "repost"),
    `${replies} ${replies === 1 ? "reply" : "replies"}`,
    plural(post.quoteCount ?? 0, "quote"),
  ].join(" · ");
}

/** What is attached to a post, one short line each: pictures (with alt text), a link card, a quoted post. */
function imagesLine(e: Record<string, unknown>): string {
  const images = Array.isArray(e["images"]) ? e["images"] : [];
  const alts = images.map((image) => str(obj(image)["alt"]) || "no alt text");
  return `[${plural(images.length, "image")}: ${alts.join(" | ")}]`;
}

function quoteLine(e: Record<string, unknown>): string {
  const record = obj(e["record"]);
  const uri = str(record["uri"]);
  if (uri === undefined) return "[quotes a post that is unavailable]";
  const handle = str(obj(record["author"])["handle"]);
  const text = str(obj(record["value"])["text"]);
  const who = handle ? `@${handle}` : "a post";
  const said = text ? `: "${text.replace(/\s+/g, " ").slice(0, 200)}"` : "";
  return `[quotes ${who}${said} - ${uri}]`;
}

function embedLines(embed: unknown): string[] {
  const e = obj(embed);
  const type = str(e["$type"]) ?? "";
  if (type.startsWith("app.bsky.embed.images")) return [imagesLine(e)];
  if (type.startsWith("app.bsky.embed.external")) {
    const external = obj(e["external"]);
    const uri = str(external["uri"]);
    return [`[link: ${str(external["title"]) || "untitled"}${uri ? ` ${uri}` : ""}]`];
  }
  if (type.startsWith("app.bsky.embed.video"))
    return [`[video: ${str(e["alt"]) || "no alt text"}]`];
  if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    return [...embedLines(e["media"]), ...embedLines(e["record"])];
  }
  if (type.startsWith("app.bsky.embed.record")) return [quoteLine(e)];
  return [];
}

/** One post as Markdown: who, when, quoted text, attachments, counts, URI and link. */
export function renderPost(post: PostView): string {
  const record = obj(post.record);
  const text = str(record["text"])?.trim() ?? "";
  const lines = [`${who(post.author)} · ${when(str(record["createdAt"]) ?? post.indexedAt)}`];
  lines.push(text === "" ? "> (no text)" : quote(text));
  const reply = obj(obj(record["reply"])["parent"]);
  if (str(reply["uri"]) !== undefined) lines.push(`In reply to ${str(reply["uri"])}`);
  lines.push(...embedLines(post.embed));
  lines.push(counts(post));
  lines.push(`${post.uri} · ${postUrl(post.uri, post.author.handle)}`);
  return lines.join("\n");
}

function cursorLine(cursor: string | undefined, tool: string): string {
  return cursor === undefined || cursor === ""
    ? "No more pages."
    : `Next page: call ${tool} again with cursor \`${cursor}\`.`;
}

export function renderTimeline(items: FeedItem[], cursor: string | undefined): string {
  if (items.length === 0) return "No posts in your home timeline.";
  const blocks = items.map((item, index) => {
    const reason = item.reason;
    const via =
      reason?.$type?.includes("reasonRepost") && reason.by ? `Reposted by ${who(reason.by)}\n` : "";
    return `### ${index + 1}\n${via}${renderPost(item.post)}`;
  });
  return `## Home timeline (${plural(items.length, "post")})\n\n${blocks.join("\n\n")}\n\n${cursorLine(cursor, "bluesky_timeline")}`;
}

const REASON_TEXT: Record<string, string> = {
  like: "liked your post",
  repost: "reposted your post",
  follow: "followed you",
  mention: "mentioned you",
  reply: "replied to you",
  quote: "quoted your post",
  "like-via-repost": "liked a repost of yours",
  "repost-via-repost": "reposted a repost of yours",
  "subscribed-post": "posted",
  verified: "verified you",
  unverified: "removed your verification",
};

function subjectLine(subject: string): string {
  const parts = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(subject);
  const link = parts?.[1] && parts[2] ? ` · ${postUrl(subject, parts[1])}` : "";
  return `On: ${subject}${link}`;
}

function renderNotification(n: Notification): string {
  const lines = [
    `- ${who(n.author)} ${REASON_TEXT[n.reason] ?? n.reason} · ${when(n.indexedAt)}${n.isRead ? "" : " (new)"}`,
  ];
  const text = str(obj(n.record)["text"])?.trim();
  if (text) lines.push(quote(text).replace(/^/gm, "  "));
  if (n.reasonSubject !== undefined) lines.push(`  ${subjectLine(n.reasonSubject)}`);
  const isPost = n.uri.includes("/app.bsky.feed.post/");
  if (isPost) lines.push(`  ${n.uri} · ${postUrl(n.uri, n.author.handle)}`);
  return lines.join("\n");
}

export function renderNotifications(items: Notification[], cursor: string | undefined): string {
  if (items.length === 0) return "No notifications.";
  return `## Notifications (${items.length})\n\n${items.map(renderNotification).join("\n")}\n\n${cursorLine(cursor, "bluesky_notifications")}`;
}

function indent(block: string, depth: number): string {
  const pad = "  ".repeat(depth);
  return block
    .split("\n")
    .map((line, index) => (index === 0 ? `${pad}- ${line}` : `${pad}  ${line}`))
    .join("\n");
}

function unavailable(node: ThreadNode): string {
  return node.$type?.includes("blocked")
    ? "(a post by a blocked account)"
    : "(deleted or unavailable post)";
}

function renderReplies(node: ThreadNode, depth: number, out: string[]): void {
  for (const reply of node.replies ?? []) {
    out.push(indent(reply.post ? renderPost(reply.post) : unavailable(reply), depth));
    renderReplies(reply, depth + 1, out);
  }
}

export function renderThread(root: ThreadNode): string {
  if (!root.post) return `The post is not available: ${unavailable(root)}`;
  const ancestors: string[] = [];
  for (let node = root.parent; node; node = node.parent) {
    ancestors.unshift(node.post ? renderPost(node.post) : unavailable(node));
  }
  const replies: string[] = [];
  renderReplies(root, 0, replies);
  return [
    "## Thread",
    ancestors.length > 0 ? `### Earlier in the thread\n\n${ancestors.join("\n\n")}` : "",
    `### This post\n\n${renderPost(root.post)}`,
    replies.length > 0 ? `### Replies\n\n${replies.join("\n")}` : "No replies.",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function renderProfile(profile: Profile): string {
  const name = profile.displayName?.trim();
  const lines = [`## ${name ? `${name} (@${profile.handle})` : `@${profile.handle}`}`];
  lines.push(`DID: ${profile.did}`);
  lines.push(`Profile: https://bsky.app/profile/${profile.handle}`);
  const bio = profile.description?.trim();
  if (bio) lines.push(quote(bio));
  lines.push(
    `${profile.followersCount ?? 0} followers · ${profile.followsCount ?? 0} following · ${plural(profile.postsCount ?? 0, "post")}`,
  );
  if (profile.createdAt) lines.push(`Joined: ${when(profile.createdAt)}`);
  return lines.join("\n");
}

export function renderSearch(
  query: string,
  items: PostView[],
  cursor: string | undefined,
  total: number | undefined,
): string {
  if (items.length === 0) return `No posts found for "${query}".`;
  const blocks = items.map((post, index) => `### ${index + 1}\n${renderPost(post)}`);
  const hits = total === undefined ? "" : ` of about ${total}`;
  return `## Search: "${query}" (${items.length}${hits} posts)\n\n${blocks.join("\n\n")}\n\n${cursorLine(cursor, "bluesky_search")}`;
}
