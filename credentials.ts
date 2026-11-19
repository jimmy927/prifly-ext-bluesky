/**
 * Where the handle and app password come from. They live in this extension's
 * own settings: the `handle` setting and the `appPassword` secret field
 * (`api.secrets`). Readers who set Bluesky up before that kept them in prifly's
 * vault (`bluesky`, `bluesky-handle`, the manifest's `vault` list); the first
 * time a value is needed it is copied from there into the extension's secrets,
 * and that copy is the only place the vault is read. MIGRATION ONLY: the vault
 * reads and the manifest's `vault` list go in a later release.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { splitToken } from "./client";

/** The vault entries of the old setup (migration only). */
export const VAULT_PASSWORD = "bluesky";
export const VAULT_HANDLE = "bluesky-handle";

/** The secret keys: `appPassword` is the settings field, `handle` the migrated handle. */
const PASSWORD_KEY = "appPassword";
const HANDLE_KEY = "handle";

export type SignIn = {
  /** Empty when none is found. */
  handle: string;
  /** Null when not set. */
  password: string | null;
  /** This read copied something out of the vault into the secrets. */
  migrated: boolean;
  /** The prifly has no `api.secrets`, so nothing can be stored or read. */
  noSecrets: boolean;
};

const clean = (s: string | null | undefined): string => (s ?? "").trim().replace(/^@/, "");

/** A vault API token, or null when absent, unreadable or on an older prifly. */
async function vaultToken(api: ExtensionApi, name: string): Promise<string | null> {
  const value = await api.vault?.read(name).catch(() => null);
  return value === undefined || value === null || value.trim() === "" ? null : value;
}

async function stored(api: ExtensionApi, key: string): Promise<string> {
  return ((await api.secrets?.get(key).catch(() => null)) ?? "").trim();
}

/** Stores `value`; a store that refuses is logged and the value is still used this time. */
async function store(api: ExtensionApi, key: string, value: string): Promise<void> {
  try {
    await api.secrets?.set(key, value);
  } catch (error) {
    api.log("could not store a migrated value", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function signIn(api: ExtensionApi | null): Promise<SignIn> {
  if (api === null || api.secrets === undefined) {
    return { handle: "", password: null, migrated: false, noSecrets: api !== null };
  }
  let migrated = false;
  const setting = api.settings?.["handle"];
  let handle = typeof setting === "string" ? clean(setting) : "";

  let password = await stored(api, PASSWORD_KEY);
  if (password === "") {
    const token = await vaultToken(api, VAULT_PASSWORD);
    if (token !== null) {
      const split = splitToken(token);
      password = split.password;
      await store(api, PASSWORD_KEY, password);
      if (split.handle !== null) await store(api, HANDLE_KEY, split.handle);
      api.log("copied bluesky from the vault into this extension's secrets");
      migrated = true;
    }
  }

  if (handle === "") handle = clean(await stored(api, HANDLE_KEY));
  if (handle === "") {
    const token = await vaultToken(api, VAULT_HANDLE);
    if (token !== null) {
      handle = clean(token);
      await store(api, HANDLE_KEY, handle);
      api.log("copied bluesky-handle from the vault into this extension's secrets");
      migrated = true;
    }
  }
  return { handle, password: password === "" ? null : password, migrated, noSecrets: false };
}
