/**
 * Turning what a reader or session types into what Bluesky wants: post links
 * into at:// URIs, handles into DIDs, text into a grapheme count and facets
 * (links and mentions).
 */

import { RichText } from "@atproto/api";
import type { AgentLike, Facet } from "./types";

export const POST_COLLECTION = "app.bsky.feed.post";
/** Bluesky's limits, in graphemes (what a reader counts as one character). */
export const POST_LIMIT = 300;
export const DM_LIMIT = 1000;

export class InputError extends Error {
  override name = "InputError";
}

const BSKY_HOSTS = new Set(["bsky.app", "www.bsky.app", "staging.bsky.app"]);

/** A post as named by an at:// URI or a bsky.app link: whose (handle or DID) and which. */
export type PostName = { authority: string; rkey: string };

export function cleanHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function bad(input: string): InputError {
  return new InputError(
    `"${input}" is not a Bluesky post. Give an at://did:plc:.../app.bsky.feed.post/<id> URI or a https://bsky.app/profile/<handle>/post/<id> link.`,
  );
}

export function parsePostName(input: string): PostName {
  const text = input.trim();
  const at = /^at:\/\/([^/\s]+)\/app\.bsky\.feed\.post\/([^/?#\s]+)\/?$/.exec(text);
  if (at?.[1] !== undefined && at[2] !== undefined) {
    return { authority: cleanHandle(at[1]), rkey: at[2] };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw bad(input);
  }
  if (!BSKY_HOSTS.has(url.hostname)) throw bad(input);
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const [profile, actor, post, rkey] = parts;
  if (parts.length !== 4 || profile !== "profile" || post !== "post" || !actor || !rkey) {
    throw bad(input);
  }
  return { authority: cleanHandle(decodeURIComponent(actor)), rkey };
}

/** The post's at:// URI, asking Bluesky for the DID when it was named by handle. */
export async function resolvePostUri(agent: AgentLike, input: string): Promise<string> {
  const name = parsePostName(input);
  const did = name.authority.startsWith("did:")
    ? name.authority
    : await resolveActor(agent, name.authority);
  return `at://${did}/${POST_COLLECTION}/${name.rkey}`;
}

/** A handle's DID, with a message that says so when there is no such account. */
export async function resolveActor(agent: AgentLike, handle: string): Promise<string> {
  const cleaned = cleanHandle(handle);
  if (cleaned === "") throw new InputError("A Bluesky handle is required.");
  if (cleaned.startsWith("did:")) return cleaned;
  try {
    return await agent.resolveHandle(cleaned);
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    // A missing account is a 400 from resolveHandle; anything else (network, rate limit) is not that.
    if (status === 400) throw new InputError(`There is no Bluesky account @${cleaned}.`);
    throw error;
  }
}

/** A profile name as a link or handle: `@ada.bsky.social`, `ada.bsky.social`, `did:plc:...`, a profile link. */
export function parseActor(input: string): string {
  const text = input.trim();
  try {
    const url = new URL(text);
    const [profile, actor] = url.pathname.split("/").filter((part) => part !== "");
    if (BSKY_HOSTS.has(url.hostname) && profile === "profile" && actor) {
      return cleanHandle(decodeURIComponent(actor));
    }
  } catch {
    // not a link: a plain handle or DID
  }
  return cleanHandle(text);
}

export function graphemeLength(text: string): number {
  return new RichText({ text }).graphemeLength;
}

/** The URL of a post on bsky.app, from its at:// URI and the author's handle (or DID). */
export function postUrl(uri: string, author: string): string {
  const rkey = uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${author}/post/${rkey}`;
}

export type Detected = {
  facets: Facet[] | undefined;
  links: string[];
  mentions: { handle: string; did: string }[];
  /** Mentions of handles that are no account: they stay plain text. */
  unresolved: string[];
};

/** The links and mentions in `text` as facets, mentions resolved to DIDs through the agent. */
export async function detectFacets(text: string, agent: AgentLike): Promise<Detected> {
  const rt = new RichText({ text });
  // RichText wants an SDK client; it only calls identity.resolveHandle on it.
  const resolver = {
    com: {
      atproto: {
        identity: {
          resolveHandle: async ({ handle }: { handle: string }) => ({
            data: { did: await agent.resolveHandle(handle) },
          }),
        },
      },
    },
  } as unknown as Parameters<RichText["detectFacets"]>[0];
  await rt.detectFacets(resolver);
  const links: string[] = [];
  const mentions: { handle: string; did: string }[] = [];
  const unresolved: string[] = [];
  const kept: Facet[] = [];
  for (const facet of rt.facets ?? []) {
    const bytes = new TextEncoder().encode(text).slice(facet.index.byteStart, facet.index.byteEnd);
    const shown = new TextDecoder().decode(bytes);
    const feature: { $type?: string; did?: string; uri?: string } | undefined = facet.features[0];
    if (feature?.$type === "app.bsky.richtext.facet#mention") {
      const did = feature.did ?? "";
      if (did === "") unresolved.push(shown);
      else {
        mentions.push({ handle: shown, did });
        kept.push(facet);
      }
    } else {
      if (feature?.$type === "app.bsky.richtext.facet#link" && feature.uri !== undefined) {
        links.push(feature.uri);
      }
      kept.push(facet);
    }
  }
  return { facets: kept.length > 0 ? kept : undefined, links, mentions, unresolved };
}
