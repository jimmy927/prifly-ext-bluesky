# prifly-ext-bluesky

A prifly extension that puts your Bluesky in any prifly session. Ask in plain
words ("what's new on my timeline?", "any replies to my last post?", "reply
to that and say thanks") and the session answers through eight tools. You
launch nothing and open no panel.

| Tool                    | What it does                                                                                                | Asks you first |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| `bluesky_timeline`      | Your home feed, paged with a cursor                                                                         | no             |
| `bluesky_notifications` | Mentions, replies, quotes, likes, reposts, follows                                                          | no             |
| `bluesky_thread`        | A post with its parents and replies, from an `at://` URI or a `bsky.app/profile/<handle>/post/<id>` link    | no             |
| `bluesky_profile`       | A handle or DID (yours by default): name, bio, counts                                                       | no             |
| `bluesky_search`        | Posts matching a query, paged                                                                               | no             |
| `bluesky_post`          | A post of up to 300 characters, optionally a reply, with up to 4 images from local files and their alt text | yes            |
| `bluesky_reply`         | A reply to a post, with the thread's root and parent set correctly                                          | yes            |
| `bluesky_dm`            | A direct message (chat) to a handle                                                                         | yes            |

Answers are Markdown: the author's name and `@handle`, the time, the post's
text (quoted, because it is somebody else's words), counts, the post's
`at://` URI and its bsky.app link so a follow-up tool can use either, and the
cursor for the next page. An empty timeline, notifications or search says "No
posts..." / "No notifications." rather than answering nothing.

## Every write asks first

`bluesky_post`, `bluesky_reply` and `bluesky_dm` show you a card with the
exact text and the target (who the message goes to, which post a reply is
under, the image file names and their alt text, the links and mentions found),
and send only when you press Confirm. If you cancel, the tool answers exactly
`Not done: you cancelled` and nothing is sent; the session is told not to try
another way.

A post over Bluesky's limit of 300 graphemes (what you would count as 300
characters; a message is limited to 1000), more than 4 images, an image that
is not a JPEG, PNG, GIF or WebP under 1 MB, a link that is not a post: each
fails with a message before the card, so you are never asked about something
that cannot be sent. Links and `@mentions` in the text become real links and
mentions (the SDK's `RichText.detectFacets`).

## Set up

1. Create an app password at <https://bsky.app/settings/app-passwords>
   (Add App Password). Tick "Allow access to your direct messages" if you want
   `bluesky_dm`. Use an app password, never your main one: it can be revoked
   on that page at any time.
2. Add it to prifly's vault: Settings -> Vault, add an API token named
   `bluesky` whose value is the app password, and leave it at level 1 (the
   extension has no card of its own to ask on at the other levels).
3. Open Settings -> Extensions -> Bluesky and type your handle, for example
   `you.bsky.social`.
4. Link the folder into prifly's extensions folder and enable it in the
   Extensions dialog:

   ```sh
   ln -s ~/src/prifly-ext-bluesky ~/.local/share/prifly/extensions/bluesky
   ```

Until 2 and 3 are done, every tool answers with these same steps. A wrong
handle or app password is reported as that, and the extension tries again the
next time you ask, so fixing the vault entry is enough.

## Behaviour

- It logs in lazily on the first call and reuses the session. If Bluesky says
  the token has expired (`ExpiredToken`, or a 401), it logs in once more and
  retries that call once; it never loops.
- It paces itself: at least 300 ms between requests, and when Bluesky's
  `ratelimit-remaining` reaches 0 the next request waits for `ratelimit-reset`
  (up to 30 s; longer is reported instead). A 429 says when to retry.
- Failures say what to do: not signed in, wrong app password, an app password
  without direct-message access, rate limit, network error, server error.
- The status line in Settings -> Extensions shows `Bluesky as @handle`, or
  that the handle and app password are still missing.

## Privacy

- The app password lives in prifly's vault (the `bluesky` API-token entry,
  read each time it is needed, and listed in the manifest's `vault`). It is
  never in a setting, a file, a log or a tool's output. Only the handle, which
  is public, is a setting.
- The extension talks only to Bluesky's servers (`bsky.social` and Bluesky's
  chat service, through your account's server) and only through Bluesky's
  official AT Protocol SDK, `@atproto/api`. No other service, no scraping, no
  analytics.
- Posts and messages are sent as you, only after you Confirm the exact text.

## Development

```sh
bun install        # fetches @prifly/extension-api from its mirror (needs your GitHub ssh key)
bun test           # tools over a fake prifly api and a fake AT Protocol agent; the SDK adapter over a fake fetch
bun run typecheck
bun run check      # biome
```

`@atproto/api` is a runtime dependency that needs no install scripts, so
prifly's `bun install --frozen-lockfile --production --ignore-scripts` is
enough. The tests make no network calls and start no process. They cannot
tell you that a real Bluesky account works; that needs a manual try with an
app password.

| File                              | What it is                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `prifly-extension.json`           | The manifest: id, the `handle` setting, the `bluesky` vault entry, `prompt.md`              |
| `prompt.md`                       | Instructions added to every session                                                         |
| `index.ts`                        | `activate(api)`: reads the handle and app password, registers the eight tools               |
| `client.ts`                       | Lazy login, session reuse, re-login on expiry, pacing, error messages                       |
| `atproto-agent.ts`                | The only code that calls Bluesky: `@atproto/api` behind the small `AgentLike` in `types.ts` |
| `read-tools.ts`, `write-tools.ts` | The five reads, and the three writes with their `api.confirm` cards                         |
| `refs.ts`, `format.ts`            | Links, handles, graphemes and facets; the Markdown                                          |
| `test/`                           | `fake-api.ts` (prifly's api), `harness.ts` (a fake agent), the tests                        |
