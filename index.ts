/**
 * The Bluesky extension: what prifly imports. `activate` registers the eight
 * tools. The app password is the vault's API-token entry `bluesky`; the handle
 * is the `handle` setting, else the API-token entry `bluesky-handle`, else the
 * front of a combined `<handle> <app-password>` token. All are read each time
 * they are needed and never kept in a file. Types come from
 * `@prifly/extension-api` with `import type`.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { createAtprotoAgent } from "./atproto-agent";
import { Bluesky, type ClientDeps, HANDLE_ENTRY, resolveSignIn, VAULT_ENTRY } from "./client";
import { readTools } from "./read-tools";
import { writeTools } from "./write-tools";

/** For tests: a fake agent in place of the SDK's, and the pacing clock. */
export type Options = {
  makeAgent?: ClientDeps["makeAgent"];
  pacing?: Pick<ClientDeps, "minGapMs" | "now" | "sleep">;
};

function settingOf(api: ExtensionApi | null): string {
  const value = api?.settings?.["handle"];
  return typeof value === "string" ? value.trim().replace(/^@/, "") : "";
}

/** A vault API token, or null when absent, unreadable or on an older prifly. */
async function vaultToken(api: ExtensionApi | null, name: string): Promise<string | null> {
  return (await api?.vault?.read(name).catch(() => null)) ?? null;
}

async function signIn(api: ExtensionApi | null) {
  const setting = settingOf(api);
  // The handle entry is only read when the setting does not already say.
  const handleToken = setting === "" ? await vaultToken(api, HANDLE_ENTRY) : null;
  return resolveSignIn(setting, handleToken, await vaultToken(api, VAULT_ENTRY));
}

function connect(api: () => ExtensionApi | null, options: Options): Bluesky {
  return new Bluesky({
    // Read each time: a vault entry the reader changes or removes takes effect at once.
    credentials: () => signIn(api()),
    makeAgent: options.makeAgent ?? ((hooks) => createAtprotoAgent(hooks)),
    ...options.pacing,
  });
}

let api: ExtensionApi | null = null;

async function saySetting(given: ExtensionApi): Promise<void> {
  const { handle, password } = await signIn(given);
  given.status?.(
    password === null
      ? "Not signed in: add the app password to the Vault as an API token named bluesky"
      : handle === ""
        ? `Not signed in: add an API token named ${HANDLE_ENTRY} to the Vault with your handle, or set it here`
        : `Bluesky as @${handle}`,
  );
}

export function activate(given: ExtensionApi, options: Options = {}): () => void {
  api = given;
  const bluesky = connect(() => api, options);
  const deps = { api: () => api, bluesky: () => bluesky, handle: () => bluesky.me() };
  // Absent on an older prifly: optional, like every part added after the first version.
  const tools = [...readTools(deps), ...writeTools(deps)];
  given.tools?.register(tools);
  void saySetting(given);
  given.onSettings?.(() => void saySetting(given));
  given.log("activated", { tools: tools.length });
  return () => {
    api = null;
  };
}
