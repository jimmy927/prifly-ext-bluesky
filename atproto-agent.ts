/**
 * `AgentLike` over Bluesky's official AT Protocol SDK (`@atproto/api`): the
 * only file that talks to Bluesky's servers. Every HTTP request goes through
 * `hooks.gate` first (pacing) and its response headers through
 * `hooks.observe` (rate limits). `fetch` and `service` can be replaced, which
 * is how tests run this against a fake server.
 */

import { AtpAgent } from "@atproto/api";
import type { AgentHooks } from "./client";
import type { AgentLike } from "./types";

export const SERVICE = "https://bsky.social";
/** Direct messages are served by Bluesky's chat service, reached through the user's own server by this proxy header. */
export const CHAT_SERVICE_DID = "did:web:api.bsky.chat";
export const CHAT_SERVICE_TYPE = "bsky_chat";

export type AtprotoOptions = {
  service?: string;
  fetch?: typeof globalThis.fetch;
};

export function createAtprotoAgent(hooks: AgentHooks, options: AtprotoOptions = {}): AgentLike {
  const gatedFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      await hooks.gate();
      const response = await (options.fetch ?? globalThis.fetch)(input, init);
      hooks.observe(response.headers);
      return response;
    },
    { preconnect: () => undefined },
  ) as typeof globalThis.fetch;
  const agent = new AtpAgent({ service: options.service ?? SERVICE, fetch: gatedFetch });
  return {
    login: async (identifier, password) => {
      const { data } = await agent.login({ identifier, password });
      return { did: data.did, handle: data.handle };
    },
    getTimeline: async ({ cursor, limit }) => {
      const { data } = await agent.getTimeline({ limit, ...(cursor ? { cursor } : {}) });
      return { items: data.feed, cursor: data.cursor };
    },
    listNotifications: async ({ cursor, limit }) => {
      const { data } = await agent.listNotifications({ limit, ...(cursor ? { cursor } : {}) });
      return { items: data.notifications, cursor: data.cursor };
    },
    getPostThread: async ({ uri, depth, parentHeight }) => {
      const { data } = await agent.getPostThread({ uri, depth, parentHeight });
      return data.thread;
    },
    getProfile: async (actor) => (await agent.getProfile({ actor })).data,
    searchPosts: async ({ q, cursor, limit, sort }) => {
      const { data } = await agent.app.bsky.feed.searchPosts({
        q,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(sort ? { sort } : {}),
      });
      return { items: data.posts, cursor: data.cursor, total: data.hitsTotal };
    },
    getPosts: async (uris) => (await agent.getPosts({ uris })).data.posts,
    resolveHandle: async (handle) => (await agent.resolveHandle({ handle })).data.did,
    createPost: async ({ text, facets, reply, images }) => {
      const uploaded = [];
      for (const image of images ?? []) {
        const { data } = await agent.uploadBlob(image.bytes, { encoding: image.mime });
        uploaded.push({ alt: image.alt, image: data.blob });
      }
      return await agent.post({
        text,
        ...(facets ? { facets } : {}),
        ...(reply ? { reply } : {}),
        ...(uploaded.length > 0
          ? { embed: { $type: "app.bsky.embed.images" as const, images: uploaded } }
          : {}),
      });
    },
    sendDirectMessage: async (did, text, facets) => {
      const chat = agent.withProxy(CHAT_SERVICE_TYPE, CHAT_SERVICE_DID).chat.bsky.convo;
      const { data: found } = await chat.getConvoForMembers({ members: [did] });
      const { data: sent } = await chat.sendMessage({
        convoId: found.convo.id,
        message: { text, ...(facets ? { facets } : {}) },
      });
      return { convoId: found.convo.id, messageId: sent.id };
    },
  };
}
