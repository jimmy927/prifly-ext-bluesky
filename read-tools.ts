/**
 * The tools that only read: `bluesky_timeline`, `bluesky_notifications`,
 * `bluesky_thread`, `bluesky_profile`, `bluesky_search`. They run at once and
 * answer in Markdown (`format.ts`).
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import type { Bluesky } from "./client";
import {
  renderNotifications,
  renderProfile,
  renderSearch,
  renderThread,
  renderTimeline,
} from "./format";
import { InputError, parseActor, resolvePostUri } from "./refs";

export type ToolDeps = {
  api: () => ExtensionApi | null;
  bluesky: () => Bluesky;
  /** The reader's handle from Settings; empty when not set. */
  handle: () => string;
};

/** A string argument; with `required`, a missing or blank one is an error. */
export function stringArg(
  args: Record<string, unknown>,
  name: string,
  required: boolean,
): string | undefined {
  const value = args[name];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new InputError(`${name} must be text.`);
  }
  if (typeof value === "string" && value.trim() !== "") return value;
  if (required) throw new InputError(`${name} is required.`);
  return undefined;
}

function limitArg(args: Record<string, unknown>, fallback: number, max: number): number {
  const value = args["limit"];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

const CURSOR = {
  type: "string",
  description: "The cursor a previous call ended with, for the next page. Leave out for the first.",
};

function limitSchema(fallback: number, max: number) {
  return {
    type: "integer",
    minimum: 1,
    maximum: max,
    description: `How many to fetch (default ${fallback}, at most ${max}).`,
  };
}

export function readTools(deps: ToolDeps): ExtensionTool[] {
  return [
    {
      name: "bluesky_timeline",
      description:
        "The reader's Bluesky home timeline, newest first, as Markdown with each post's author, time, text, counts, at:// URI and bsky.app link. Paged: pass the cursor it ends with for the next page.",
      inputSchema: {
        type: "object",
        properties: { cursor: CURSOR, limit: limitSchema(20, 50) },
        additionalProperties: false,
      },
      call: async (args) => {
        const cursor = stringArg(args, "cursor", false);
        const limit = limitArg(args, 20, 50);
        const page = await deps.bluesky().run((agent) => agent.getTimeline({ cursor, limit }));
        return renderTimeline(page.items, page.cursor);
      },
    },
    {
      name: "bluesky_notifications",
      description:
        "The reader's Bluesky notifications: mentions, replies, quotes, likes, reposts and new followers, newest first, with the at:// URI and link of each post. Paged with a cursor. Reading does not mark them seen.",
      inputSchema: {
        type: "object",
        properties: { cursor: CURSOR, limit: limitSchema(30, 100) },
        additionalProperties: false,
      },
      call: async (args) => {
        const cursor = stringArg(args, "cursor", false);
        const limit = limitArg(args, 30, 100);
        const page = await deps
          .bluesky()
          .run((agent) => agent.listNotifications({ cursor, limit }));
        return renderNotifications(page.items, page.cursor);
      },
    },
    {
      name: "bluesky_thread",
      description:
        "A Bluesky post with the posts it replies to and the replies under it, by at:// URI or a bsky.app/profile/<handle>/post/<id> link.",
      inputSchema: {
        type: "object",
        properties: {
          post: { type: "string", description: "The at:// URI or bsky.app link of the post." },
          depth: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description: "How many levels of replies (default 4).",
          },
        },
        required: ["post"],
        additionalProperties: false,
      },
      call: async (args) => {
        const post = stringArg(args, "post", true) ?? "";
        const depth =
          typeof args["depth"] === "number"
            ? Math.min(10, Math.max(0, Math.trunc(args["depth"])))
            : 4;
        const thread = await deps.bluesky().run(async (agent) =>
          agent.getPostThread({
            uri: await resolvePostUri(agent, post),
            depth,
            parentHeight: 10,
          }),
        );
        return renderThread(thread);
      },
    },
    {
      name: "bluesky_profile",
      description:
        "A Bluesky profile: name, handle, bio and counts. Give a handle or DID; left out, it is the reader's own.",
      inputSchema: {
        type: "object",
        properties: {
          actor: {
            type: "string",
            description: "A handle (ada.bsky.social), DID or profile link. Default: the reader.",
          },
        },
        additionalProperties: false,
      },
      call: async (args) => {
        const given = stringArg(args, "actor", false);
        const actor = given === undefined ? deps.handle() : parseActor(given);
        const profile = await deps
          .bluesky()
          .run((agent) => agent.getProfile(actor.trim().replace(/^@/, "")));
        return renderProfile(profile);
      },
    },
    {
      name: "bluesky_search",
      description:
        'Searches Bluesky posts. Paged: pass the cursor it ends with for the next page. Supports Bluesky\'s search syntax (from:handle, #tag, "phrases").',
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for." },
          sort: {
            type: "string",
            enum: ["latest", "top"],
            description: "Newest first (default) or most popular.",
          },
          cursor: CURSOR,
          limit: limitSchema(20, 50),
        },
        required: ["query"],
        additionalProperties: false,
      },
      call: async (args) => {
        const q = stringArg(args, "query", true) ?? "";
        const cursor = stringArg(args, "cursor", false);
        const limit = limitArg(args, 20, 50);
        const sort = args["sort"] === "top" ? "top" : "latest";
        const page = await deps
          .bluesky()
          .run((agent) => agent.searchPosts({ q, cursor, limit, sort }));
        return renderSearch(q, page.items, page.cursor, page.total);
      },
    },
  ];
}
