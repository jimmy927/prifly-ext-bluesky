/**
 * The Bluesky extension: what prifly imports. `activate` registers the eight
 * tools. The handle is a setting; the app password is the vault's API-token
 * entry `bluesky`, read each time it is needed and never kept in a file or a
 * setting. Types come from `@prifly/extension-api` with `import type`.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { createAtprotoAgent } from "./atproto-agent";
import { Bluesky, type ClientDeps, VAULT_ENTRY } from "./client";
import { readTools } from "./read-tools";
import { writeTools } from "./write-tools";

/** For tests: a fake agent in place of the SDK's, and the pacing clock. */
export type Options = {
  makeAgent?: ClientDeps["makeAgent"];
  pacing?: Pick<ClientDeps, "minGapMs" | "now" | "sleep">;
};

function handleOf(api: ExtensionApi | null): string {
  const value = api?.settings?.["handle"];
  return typeof value === "string" ? value.trim().replace(/^@/, "") : "";
}

function connect(api: () => ExtensionApi | null, options: Options): Bluesky {
  return new Bluesky({
    // Read each time: a password the reader changes or removes in the Vault takes effect at once.
    credentials: async () => ({
      handle: handleOf(api()),
      password:
        (await api()
          ?.vault?.read(VAULT_ENTRY)
          .catch(() => null)) ?? null,
    }),
    makeAgent: options.makeAgent ?? ((hooks) => createAtprotoAgent(hooks)),
    ...options.pacing,
  });
}

let api: ExtensionApi | null = null;

function saySetting(given: ExtensionApi): void {
  const handle = handleOf(given);
  given.status?.(
    handle === ""
      ? "Not signed in: set your handle here and add an app password to the Vault"
      : `Bluesky as @${handle}`,
  );
}

export function activate(given: ExtensionApi, options: Options = {}): () => void {
  api = given;
  const bluesky = connect(() => api, options);
  const deps = { api: () => api, bluesky: () => bluesky, handle: () => handleOf(api) };
  // Absent on an older prifly: optional, like every part added after the first version.
  const tools = [...readTools(deps), ...writeTools(deps)];
  given.tools?.register(tools);
  saySetting(given);
  given.onSettings?.(() => saySetting(given));
  given.log("activated", { tools: tools.length });
  return () => {
    api = null;
  };
}
