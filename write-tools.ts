/**
 * The tools that send something: `bluesky_post`, `bluesky_reply`,
 * `bluesky_dm`. Each checks its input, looks up what it needs (the post
 * replied to, the recipient's DID, the facets), then asks the reader on an
 * `api.confirm` card showing the exact text and target, and sends only on
 * Confirm. Too long, too many images and unknown links fail before the card.
 */

import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import type { Bluesky } from "./client";
import { stringArg, type ToolDeps } from "./read-tools";
import {
  cleanHandle,
  type Detected,
  DM_LIMIT,
  detectFacets,
  graphemeLength,
  InputError,
  POST_LIMIT,
  parseActor,
  postUrl,
  resolveActor,
  resolvePostUri,
} from "./refs";
import type { AgentLike, NewImage, PostRef, PostView } from "./types";

/** What a session is told when the reader said no: it must not try another way. */
export const CANCELLED = "Not done: you cancelled";
export const CANNOT_ASK = "Not done: this prifly cannot ask you first. Update prifly.";

export const MAX_IMAGES = 4;
/** Bluesky refuses an image blob over 1,000,000 bytes. */
export const MAX_IMAGE_BYTES = 1_000_000;

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type Attachment = NewImage & { path: string };

/** The text, checked against Bluesky's limit; throws a message that says by how much it is over. */
function checkedText(
  args: Record<string, unknown>,
  limit: number,
  what: string,
  allowEmpty: boolean,
) {
  const text = stringArg(args, "text", !allowEmpty) ?? "";
  const length = graphemeLength(text);
  if (length > limit) {
    throw new InputError(
      `Too long for Bluesky: ${what} is ${length} characters (graphemes) and the limit is ${limit}; shorten it by ${length - limit}. Nothing was sent.`,
    );
  }
  return { text, length };
}

/** `images`: up to four `{path, alt}` from local absolute paths, read now so a bad file fails before the card. */
async function readImages(args: Record<string, unknown>): Promise<Attachment[]> {
  const given = args["images"];
  if (given === undefined) return [];
  if (!Array.isArray(given)) throw new InputError("images must be a list of {path, alt}.");
  if (given.length > MAX_IMAGES) {
    throw new InputError(
      `Bluesky allows at most ${MAX_IMAGES} images in a post; ${given.length} were given. Nothing was sent.`,
    );
  }
  const out: Attachment[] = [];
  for (const item of given) {
    const path = (item as { path?: unknown } | null)?.path;
    const alt = (item as { alt?: unknown } | null)?.alt;
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new InputError(
        `An image path must be a local absolute path, got ${JSON.stringify(path)}.`,
      );
    }
    const mime = MIME[extname(path).toLowerCase()];
    if (mime === undefined) {
      throw new InputError(`${basename(path)} is not a JPEG, PNG, GIF or WebP image.`);
    }
    const bytes = await readFile(path).catch((error: unknown) => {
      throw new InputError(
        `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new InputError(
        `${basename(path)} is ${bytes.length} bytes; Bluesky takes images up to ${MAX_IMAGE_BYTES} bytes. Make it smaller.`,
      );
    }
    out.push({ path, bytes, mime, alt: typeof alt === "string" ? alt : "" });
  }
  return out;
}

type Target = { ref: PostRef; root: PostRef; post: PostView };

/** The post being replied to, and the thread's first post: a reply's root is its parent's root. */
async function replyTarget(agent: AgentLike, input: string): Promise<Target> {
  const uri = await resolvePostUri(agent, input);
  const [post] = await agent.getPosts([uri]);
  if (post === undefined)
    throw new InputError(`No such post: ${uri} (deleted, or not visible to you).`);
  const parent: PostRef = { uri: post.uri, cid: post.cid };
  const inner = (post.record as { reply?: { root?: PostRef } } | null)?.reply?.root;
  const root = inner?.uri && inner.cid ? { uri: inner.uri, cid: inner.cid } : parent;
  return { ref: parent, root, post };
}

function snippet(post: PostView): string {
  const text = (post.record as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text.replace(/\s+/g, " ").slice(0, 160) : "";
}

function detailLines(detected: Detected, ...extra: string[]): string {
  const lines = [...extra];
  if (detected.links.length > 0) lines.push(`Links: ${detected.links.join(", ")}`);
  if (detected.mentions.length > 0) {
    lines.push(`Mentions: ${detected.mentions.map((m) => `${m.handle} (${m.did})`).join(", ")}`);
  }
  if (detected.unresolved.length > 0) {
    lines.push(`Not accounts, left as plain text: ${detected.unresolved.join(", ")}`);
  }
  return lines.join("\n");
}

async function ask(
  api: ExtensionApi | null,
  spec: Parameters<NonNullable<ExtensionApi["confirm"]>>[0],
) {
  const confirm = api?.confirm;
  if (confirm === undefined) return CANNOT_ASK;
  return (await confirm(spec)) ? null : CANCELLED;
}

/** Posts, and replies: a reply is a post with `replyTo`. */
async function sendPost(
  deps: ToolDeps,
  args: Record<string, unknown>,
  replyTo: string | undefined,
): Promise<string> {
  const images = await readImages(args);
  const { text, length } = checkedText(args, POST_LIMIT, "the post", images.length > 0);
  if (text.trim() === "" && images.length === 0) throw new InputError("text is required.");
  const bluesky: Bluesky = deps.bluesky();
  const prepared = await bluesky.run(async (agent) => ({
    target: replyTo === undefined ? undefined : await replyTarget(agent, replyTo),
    detected: await detectFacets(text, agent),
  }));
  const { target, detected } = prepared;
  const me = cleanHandle(deps.handle());
  const where = target
    ? `reply to @${target.post.author.handle}: ${postUrl(target.ref.uri, target.post.author.handle)}`
    : "new post";
  const stopped = await ask(deps.api(), {
    title: target ? "Reply on Bluesky" : "Post on Bluesky",
    summary: `${target ? `Reply to @${target.post.author.handle}'s post` : "Post"} on Bluesky as @${me}${
      images.length > 0
        ? `, with ${images.length} image${images.length === 1 ? "" : "s"} (${images.map((i) => basename(i.path)).join(", ")})`
        : ""
    }`,
    content: text,
    details: detailLines(
      detected,
      `Account: @${me}`,
      `Kind: ${where}`,
      `Length: ${length} of ${POST_LIMIT} characters (graphemes)`,
      ...(target
        ? [
            `Replying to: ${target.ref.uri} - "${snippet(target.post)}"`,
            `Thread root: ${target.root.uri}`,
          ]
        : []),
      ...images.map(
        (i, n) =>
          `Image ${n + 1}: ${basename(i.path)} (${i.path}), alt text: ${i.alt === "" ? "none" : JSON.stringify(i.alt)}`,
      ),
    ),
  });
  if (stopped !== null) return stopped;
  const created = await bluesky.run((agent) =>
    agent.createPost({
      text,
      facets: detected.facets,
      reply: target ? { root: target.root, parent: target.ref } : undefined,
      images: images.map(({ bytes, mime, alt }) => ({ bytes, mime, alt })),
    }),
  );
  const link = postUrl(created.uri, me || created.uri.split("/")[2] || "");
  return `${target ? "Replied" : "Posted"}. ${created.uri}\n${link}`;
}

const IMAGES_SCHEMA = {
  type: "array",
  maxItems: MAX_IMAGES,
  description: `Up to ${MAX_IMAGES} pictures to attach: {path} is a local absolute file path (JPEG, PNG, GIF or WebP, under 1 MB), {alt} describes it for people who cannot see it.`,
  items: {
    type: "object",
    properties: { path: { type: "string" }, alt: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

function postTool(deps: ToolDeps): ExtensionTool {
  return {
    name: "bluesky_post",
    description: `Posts on Bluesky as the reader (up to ${POST_LIMIT} characters, optional images, optional replyTo). The reader sees a card with the exact text and target and the post is sent only when they Confirm; when they cancel the tool answers "${CANCELLED}" and nothing is sent.`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: `The post, as it is to appear. At most ${POST_LIMIT} characters; links and @mentions become real links.`,
        },
        replyTo: {
          type: "string",
          description:
            "Optional: the at:// URI or bsky.app link of a post to reply to (bluesky_reply is the same, with it required).",
        },
        images: IMAGES_SCHEMA,
      },
      required: ["text"],
      additionalProperties: false,
    },
    call: async (args) => await sendPost(deps, args, stringArg(args, "replyTo", false)),
  };
}

function replyTool(deps: ToolDeps): ExtensionTool {
  return {
    name: "bluesky_reply",
    description: `Replies to a Bluesky post as the reader, with the thread's root and the parent set correctly. The reader sees a card with the exact text and the post replied to and the reply is sent only when they Confirm; when they cancel the tool answers "${CANCELLED}" and nothing is sent.`,
    inputSchema: {
      type: "object",
      properties: {
        replyTo: {
          type: "string",
          description: "The at:// URI or bsky.app link of the post to reply to.",
        },
        text: { type: "string", description: `The reply. At most ${POST_LIMIT} characters.` },
        images: IMAGES_SCHEMA,
      },
      required: ["replyTo", "text"],
      additionalProperties: false,
    },
    call: async (args) => await sendPost(deps, args, stringArg(args, "replyTo", true)),
  };
}

function dmTool(deps: ToolDeps): ExtensionTool {
  return {
    name: "bluesky_dm",
    description: `Sends a Bluesky direct message (chat) to a handle, as the reader. The reader sees a card with the recipient and the exact text and it is sent only when they Confirm; when they cancel the tool answers "${CANCELLED}" and nothing is sent. Needs an app password with direct messages allowed.`,
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Who to message: a handle like ada.bsky.social, or a DID.",
        },
        text: { type: "string", description: `The message. At most ${DM_LIMIT} characters.` },
      },
      required: ["handle", "text"],
      additionalProperties: false,
    },
    call: async (args) => {
      const wanted = parseActor(stringArg(args, "handle", true) ?? "");
      const { text, length } = checkedText(args, DM_LIMIT, "the message", false);
      const bluesky = deps.bluesky();
      const { did, detected } = await bluesky.run(async (agent) => ({
        did: await resolveActor(agent, wanted),
        detected: await detectFacets(text, agent),
      }));
      const stopped = await ask(deps.api(), {
        title: "Send a Bluesky message",
        summary: `Send a direct message to ${wanted.startsWith("did:") ? wanted : `@${wanted}`}`,
        content: text,
        details: detailLines(
          detected,
          `From: @${cleanHandle(deps.handle())}`,
          `To: ${wanted} (${did})`,
          `Length: ${length} of ${DM_LIMIT} characters (graphemes)`,
        ),
      });
      if (stopped !== null) return stopped;
      await bluesky.run((agent) => agent.sendDirectMessage(did, text, detected.facets));
      return `Sent your message to ${wanted.startsWith("did:") ? wanted : `@${wanted}`}.`;
    },
  };
}

export function writeTools(deps: ToolDeps): ExtensionTool[] {
  return [postTool(deps), replyTool(deps), dmTool(deps)];
}
