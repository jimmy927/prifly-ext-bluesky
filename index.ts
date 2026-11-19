/**
 * The Bluesky extension: what prifly imports. `activate` registers the eight
 * tools. The app password is the `appPassword` secret field and the handle the
 * `handle` setting (see credentials.ts, which also copies an old vault entry
 * into the extension's secrets). Both are read each time they are needed and
 * never kept in a file. Types come from
 * `@prifly/extension-api` with `import type`.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { createAtprotoAgent } from "./atproto-agent";
import { Bluesky, type ClientDeps, SIGN_IN_STEPS } from "./client";
import { signIn } from "./credentials";
import { readTools } from "./read-tools";
import { writeTools } from "./write-tools";

/** For tests: a fake agent in place of the SDK's, and the pacing clock. */
export type Options = {
  makeAgent?: ClientDeps["makeAgent"];
  pacing?: Pick<ClientDeps, "minGapMs" | "now" | "sleep">;
};

function connect(api: () => ExtensionApi | null, options: Options): Bluesky {
  return new Bluesky({
    // Read each time: a setting or secret the reader changes or removes takes effect at once.
    credentials: () => signIn(api()),
    makeAgent: options.makeAgent ?? ((hooks) => createAtprotoAgent(hooks)),
    ...options.pacing,
  });
}

let api: ExtensionApi | null = null;

async function saySetting(given: ExtensionApi): Promise<void> {
  const { handle, password, migrated, noSecrets } = await signIn(given);
  given.status?.(
    noSecrets
      ? "Not signed in: this version of prifly cannot keep the app password. Update prifly."
      : password === null
        ? `Not signed in. ${SIGN_IN_STEPS}`
        : handle === ""
          ? "Not signed in: enter your handle (for example you.bsky.social) in Settings -> Extensions -> Bluesky"
          : migrated
            ? `Bluesky as @${handle}. Copied from the Vault: you can now remove the old bluesky entries in the Vault dialog.`
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
