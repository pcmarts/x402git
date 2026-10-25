# Admin notifications

The platform tells one operator, in one place, when something happens that a person
should know about: a creator signed up, a listing went up, money settled, an operator
paused something, or something broke. The place is a Telegram channel. FR-35 and FR-39 both say "admin alert" and until
13 Sep 2026 that phrase had nothing behind it — the events were written to the `event`
table and read on `/admin/activity` by whoever thought to look.

**Why Telegram.** It is a channel the founder already reads, on a phone, without adding
an account or a subscription. It costs nothing at four messages a day. And the shape is
right: the bot only ever calls out to `api.telegram.org`, there is no inbound webhook and
no route to register, so nothing about this system is reachable from the internet. A bot
that cannot be talked to cannot be attacked. Telegram never becomes a control surface
either — no button in a message does anything, because FR-39 is the only path that acts
and it is a human at `/admin`.

This is not error monitoring. It is a nudge to go and look at `/admin`, which is where
the actual answer lives. A real error tool (stack traces, grouping, release tracking) is
a later decision; see DECISIONS.md, "Admin notifications go to Telegram".

## Setup

Done once, already done for production. Repeat it only if the bot or the channel is
recreated.

1. **The bot.** BotFather → `/newbot` → `<your bot>` (bot id `<bot-id>`). The token
   it prints is `TELEGRAM_BOT_TOKEN`. It is a bearer credential in a URL path — anyone
   holding it can post as the bot — so it is never logged, never printed by a script,
   and never committed.
2. **The channel.** A private supergroup, id `<chat-id>`. Add the bot as
   an **administrator** of it. A plain member cannot post, and Telegram answers `403 bot
   is not a member of the channel chat` rather than something that reads like a bug.
3. **The chat id.** Post any message in the channel, then read
   `https://api.telegram.org/bot<token>/getUpdates` and take `result[].channel_post.chat.id`.
   Supergroup and channel ids begin `-100`. This is how the current id was found; if the
   channel is ever recreated, this is how to find the new one. `npm run telegram:check`
   prints the chat it is configured for, which is the faster way to confirm you have it
   right.
4. **The env.** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID`, both read through
   `telegramConfig()` in `lib/env.ts`. They are in `.env.example`, and in Vercel:

   ```
   vercel env add TELEGRAM_BOT_TOKEN production --sensitive
   vercel env add TELEGRAM_ADMIN_CHAT_ID production
   ```

**Production only.** Preview deployments do not get the variables, so a branch deploy
never posts. Unset either variable and every send is a silent no-op that returns
`unconfigured` — the same posture `sendAbuseWebhook` takes without `ABUSE_WEBHOOK_SECRET`.
Local development is therefore silent by default, which is what you want: a dev server
replaying a payment should not page anyone.

**Rotating the token.** BotFather `/revoke` invalidates the old one immediately, then
`vercel env rm TELEGRAM_BOT_TOKEN production`, `vercel env add … production --sensitive`,
and redeploy — Vercel env changes do not reach running functions until a deploy. Between
the revoke and the deploy every send fails with `401` and nothing else breaks.

## The five events

`notifyAdmin(event)` in `lib/notify/index.ts` takes an `AdminEvent`, one of five kinds,
and `formatAdminEvent` turns it into the message. The formatter is pure and its exact
output is asserted in `lib/notify/index.test.ts`; the transport is `sendTelegram(text)` in
`lib/notify/telegram.ts`.

Every message is the same shape: an emoji and a bold headline, a few `key: value` lines,
then the `/admin` page that has the rest. Nothing is a summary and nothing is a digest —
at this volume the log *is* the feed. The examples below are as they render in Telegram;
the headline is bold.

### `creator_joined` 👤

Raised from `lib/web/onboard.ts` (FR-1, the web signup) and `app/api/creators/route.ts`
(FR-2, the API), so `via` says which door they came through. The creator id is on the
event and deliberately not in the message — the handle is what you search on, and the
link goes to the page that has the id.

```
👤 New creator @examples
via: web
wallet: self_custody
https://x402git.com/admin/creators/examples
```

### `listing_created` 📦

From `lib/listings/service.ts`, at creation, not at publish — a draft appearing is the
interesting moment, and the listing may never go live. `rail` is `hosted` (Rail B) or
`linked` (Rail A). `wallet` and `visibility` are optional and are printed only when the
caller passes them.

```
📦 New listing examples/agent-skills
price: $9.00 USDC
rail: hosted
visibility: public
https://x402git.com/admin/listings/8c1f0a3d
```

### `payment_settled` 💸

From `lib/x402/flow.ts`, immediately after `record({ name: "settled" })` — so it fires
only on the far side of a facilitator `settle` that returned a tx hash, which is the same
line the grant is conditioned on. Gross is `bigint` micro-USDC through `formatAmount`
(`1500000n` → `$1.50 USDC`); it is never parsed back and never a float. `kind` is the
purchase kind (`new` or `update`) and `source` is where the buy came from (`api`, `mcp`,
`web`…).

**Every money message names its chain.** One Supabase project serves Base and Base
Sepolia (migration 20260906010000), so a test purchase and a real one are otherwise
indistinguishable in a phone notification — the same reason `lib/admin/feed.ts` filters
every purchase query on `chain_id` and prints the chain on the page. The label comes from
`chainLabel` in `lib/buy-links.ts`.

The tx hash is the one address-shaped thing that travels, because it is public on chain
the moment it settles. It is shortened and linked to basescan.

```
💸 $9.00 USDC — examples/agent-skills
version: 1.2.0
kind: new
source: api
chain: Base
tx: 0x4f2a…9c1d
https://x402git.com/admin/listings/8c1f0a3d
```

### `error` 🚨 / ⚠️

Severity `error` is 🚨 and is the default; `alert` is ⚠️, the quieter "worth a look" —
"something threw" against "a check could not run". Both link to `/admin/activity`, and
both carry `where`, an optional code, a message, an optional listing id, and any extra
`details` as further `key: value` lines.

```
🚨 Error in /api/listings
message: TypeError: Cannot read properties of undefined (reading 'slug')
https://x402git.com/admin/activity
```

```
🚨 Error in release_scan_socket_auth
code: release_scan_socket_auth
message: Socket answered 401 — token probably rotated
listing: 8c1f0a3d-…
version: 1.2.0
https://x402git.com/admin/activity
```

### `admin_action` 🔒

Added 14 Sep 2026. Every operator action on the `/admin/audit` trail also arrives on the
phone: a kill switch thrown or released, a listing taken down, purchases revoked, an
administrator granted or revoked. The trail answers "who paused payments at 3am" for
whoever goes and looks; this is what makes them look, and it is the only thing that
reaches the operator who was *not* the one clicking — which, for a control that anyone
with `/admin` can reach, is the case worth covering.

`action` is an `AuditEventName` from `lib/admin/audit.ts` or `admin_granted` /
`admin_revoked`; the headline renders it as a phrase (`switch_paused` → "Switch paused"),
and an action name the table has not caught up with prints as itself rather than as the
word for not knowing it. `by` is the GitHub login from the session or the OS username of
whoever ran the script — never a form value. `subject` is the switch name, the
`handle/slug` ref, or the login. `via` is `admin` or `script`, the same distinction
`/admin/audit` draws. The link is the listing page when the action had a listing and
`/admin/audit` otherwise.

```
🔒 Switch paused by pcmarts
subject: payments
via: admin
reason: facilitator returning 5xx
https://x402git.com/admin/audit
```

```
🔒 Listing retired (takedown) by paul
subject: examples/agent-skills
via: script
reason: upheld DMCA notice #12
https://x402git.com/admin/listings/8c1f0a3d
```

**When the audit row failed to save, the message says so and the message is the record.**
`recordAdminAction` returns the error instead of throwing, because the pause has already
happened by the time the insert fails; the notification goes out on both paths, carrying
`auditError`, precisely because the run where the durable row is missing is the run where
a phone is all there is.

```
🔒 Switch paused by pcmarts
subject: payments
via: admin
⚠️ audit row did not save: could not connect to the database
https://x402git.com/admin/audit
```

| Source | What it sends |
| --- | --- |
| `recordAdminAction` in `lib/admin/audit.ts` | The web half: `switch_paused`, `switch_resumed` and `takedown_retired`, from `changeSwitch` and `takeDownListing` in `lib/admin/controls.ts`. One call site for all three, next to the insert, so a control added later gets the notification by writing its audit row and nothing else. `subject` and `reason` are read off `props` (`props.switch`, `props.ref`, `props.reason`) defensively — a prop that is not a string prints as `—` rather than as `[object Object]` |
| `grantAdmin` / `revokeAdmin` in `lib/admin/people.ts` | `admin_granted` and `admin_revoked`, after the `admin` table write and only then: a refused re-grant or a refused self-revoke changed nothing and is not news. There is no `auditError` on these — the `admin` table *is* the audit record for a grant (see `lib/admin/audit.ts`), so there is no second row to fail. The one `ok: false` that does post is revoking a root login's granted row, which writes; the caveat travels in `reason` |
| `scripts/ops-takedown.mjs` | `takedown_retired` and `takedown_revoked` from the terminal, with `via: script` and `by` = the OS username the script already writes into `props`. It prints one line saying whether the post landed, and a failure there is never fatal — the takedown already happened |

**Never throttled.** The throttle in `lib/notify/index.ts` applies to `kind: "error"` and
to nothing else, and an operator action is the clearest case for staying outside it: there
is at most one a week, two of them inside ten minutes is two people reaching for the same
switch during the same incident — exactly the pair you must see — and the one that gets
suppressed is by definition the one you did not do yourself.

**The script duplicates the shape rather than the formatter.** `ops-takedown.mjs` writes
its audit row by direct insert and cannot import TypeScript (no tsx, no ts-node, and
`lib/notify` imports through the `@/` alias), so the 🔒 message is spelled out by hand
there against the same rendering. What is *not* duplicated is the wire:
`scripts/lib/telegram.mjs` is the one transport both scripts post through, keeping the
four transport rules (never throws, silent when unconfigured, 3 s, never prints the token)
in one place. Keep the message shape in step by eye; `lib/notify/index.test.ts` asserts
the authoritative one character for character.

## Where errors come from, and the throttle

Two call sites, and nothing else:

| Source | What it sends |
| --- | --- |
| `handle()` in `lib/errors.ts` | The **500 `internal` path only** — an unhandled throw inside a route. `where` is the request path; there is no `code` because the throw had none. A catalogue `ApiError` (`not_found`, `invalid_signature`, `price_changed`…) is an expected client outcome, and FR-33 makes every one of them catalogue-shaped on purpose; paging on those would page on somebody's typo. The three cron routes (`/api/cron/sweep`, `reconcile`, `rescan`) are wrapped in `handle()` too, so a cron that dies at 03:00 arrives here with `where: /api/cron/rescan` |
| `record()` in `lib/events.ts` | The PRD's named admin alerts, which already arrive as event names: `release_compromised` (🚨 — FR-39, amended 13 Sep 2026: a notice, never an action), `release_scan_socket_auth` (🚨) and `release_scan_socket_quota` (⚠️). The `ADMIN_ALERTS` table in that file maps the name to a severity and a message; `where` and `code` are both the event name, and the scalar `props` (`version`, `release_id`, …) become `details` lines — minus `buyer_address` and anything address-shaped. Hooking them here, rather than in `lib/release/index.ts` and `lib/scan/rescan.ts`, means the scan code has one thing to do (`record`) and the alert follows |

**The throttle.** A route that throws once usually throws on every request until someone
fixes it. So: the same key posts at most **once per 10 minutes** (`ERROR_THROTTLE_MS`),
and there are at most **20 error posts per rolling hour** (`ERROR_HOURLY_CAP`). The key
is `where:code`, falling back to the first 80 characters of the message when the event
carries no code. Suppressed sends return `reason: "throttled"` rather than pretending to
have delivered. Tests clear the counters with `resetNotifyThrottle()`.

It is in-process and therefore best-effort. Fluid Compute reuses instances, so in practice
one runaway route is one message; it does not *promise* to, so two instances can each post
once. That is the right trade: the alternative is a table and a write on every error path,
which is machinery in the way of the thing that is already broken. The counters do not
survive a cold start, which is also correct — a new instance has no idea what the old one
already told you, and the failure mode is one duplicate message.

Every admin alert is also an `event` row, and `/admin/activity` is the complete list of
those; an unhandled 500 is a `[unhandled]` line in the Vercel logs (`vercel logs`), not a
row. Telegram is lossy on purpose; neither of those is.

## Privacy and failure

**No buyer address, no payout address, no API key, no token, no secret, in any message.**
FR-40 keeps buyer identity away from creators and there is no reason an operator needs an
address in a phone notification to know a sale happened — this is exactly the line
`lib/admin/feed.ts` holds, where the buyer column is never even selected. A sale is a
listing, a version, an amount, a kind, a source and a chain. Nothing here selects an
address, so nothing here can print one.

Everything user-supplied — a handle, a slug, an error message — is HTML-escaped before it
goes into the message, because the parse mode is HTML and a listing slug is a creator-
supplied string. An unescaped `<` breaks the send with `400 can't parse entities`, which
is the good outcome; the bad one is a creator naming a listing `<b>` and shaping what the
operator reads.

**`notifyAdmin` never throws and never rejects**, including on a bug in its own formatter
— the rule `record()` in `lib/events.ts` keeps, for the same reason `sendAbuseWebhook`
keeps it: an outbound call to a third party must never be able to fail a paid request or
a cron. The ceiling is in the transport: `sendTelegram` gives up after **3 seconds**, so
three seconds is the most a call site can pay whether it awaits the promise or `void`s
it. Unconfigured, non-2xx, network fault, timeout: each is
a `TelegramSendResult` with a `reason` (`unconfigured`, `http_403`, `timeout`,
`transport: …`) and one `console.warn` prefixed `[notify]`. If Telegram is down, the
buyer still gets their bytes and the sweep still pays. The message is lost and the
`event` row is not.

The token lives in the request *path*, so the URL is never logged and every reason string
is run through `redactToken` before the warn — a `fetch` implementation is entitled to
quote the URL in its own error message, and a log drain is not a place for a bot token.
Messages over 4096 characters are rejected by the API outright, so `truncateForTelegram`
cuts at 4000 and drops any half-written entity or tag at the seam; and link previews are
disabled, or a listing link would unfurl the whole manifest page under every message.

Awaited rather than fired and forgotten, because a serverless function that returns has
no promise the runtime will finish anything still in flight. Three seconds is the ceiling
on being wrong about that; it is also the point at which the notification has stopped
being worth the buyer's wait.

## `npm run telegram:check`

`scripts/telegram-check.mjs`, read-only by default:

```
npm run telegram:check          # getMe, getChat, and whether the bot can post there
npm run telegram:check -- --send  # posts one sample message of each of the five kinds
```

It reads `.env` then `.env.local` (the shell wins over both, the same rule
`scripts/socket-check.mjs` follows) and answers the three questions in order: `getMe` —
is the token live and which bot is it; `getChat` — does the chat id name a chat this bot
can see; `getChatMember` — is the bot an *administrator* there, since a channel silently
drops a non-admin's posts, which looks exactly like a working integration nobody reads.
It exits 1 on the first failure, and it never prints the token: only the variable it came
from, its length, the bot id in front of the colon, and Bot API method names. Run it after
rotating the token, after recreating the channel, and before believing that silence means
nothing has happened.

The `--send` samples are hand-written approximations of `formatAdminEvent`, not the
formatter itself — there is no TypeScript loader for `.mjs` scripts in this repo and
`lib/notify/index.ts` imports through the `@/` alias. They exist to prove the channel
works end to end; the authoritative rendering is asserted character for character in
`lib/notify/index.test.ts`. The posting goes through `scripts/lib/telegram.mjs`, the same
transport `scripts/ops-takedown.mjs` announces a takedown with; the three read-only checks
stay on the script's own `api()` helper, which needs the parsed result and should exit 1
on the first failure rather than shrug the way a notifier does.

## Troubleshooting

| Symptom | What it means | Fix |
| --- | --- | --- |
| `unconfigured` | One of the two variables is empty. Every send is a no-op | Expected locally and on previews. On production: `vercel env ls`, then redeploy — env changes need a deploy |
| `403 bot is not a member of the channel chat` | The bot was removed, or was never added as an administrator | Re-add it as an admin of the channel. Being a member is not enough |
| `400 chat not found` | Wrong chat id, or the channel was recreated (a new one gets a new id) | Find the id again with `getUpdates` (step 3 above), then update the env var |
| `400 can't parse entities` | Something reached the message unescaped | A bug in the formatter, not in the data. Add the case to the formatter test |
| `failed` | `formatAdminEvent` itself threw; the warn reads `[notify] could not send <kind>` | A formatter bug. Nothing was sent and nothing else broke, which is the point |
| `429 Too Many Requests` | Telegram's own rate limit, ~20 messages a minute to one chat | Nothing to do. The throttle exists so this stays theoretical; if it is not, the error rate is the real problem |
| Timeout after 3s | Telegram slow or unreachable | Nothing to do. The message is dropped by design; `/admin/activity` still has the event |
| Nothing at all, no error | Preview deploy, or a `$0` listing, or a catalogue 4xx — see below | Check `/admin/activity`. If the event is there and the message is not, run `npm run telegram:check` |

## What is deliberately not notified

- **Free grants.** A `$0` listing produces a `free_grant` event, not a payment. Notifying
  it would put the word "sale" next to no money, and the example listings alone would
  make the channel noise.
- **Catalogue 4xx errors.** `not_found`, `invalid_signature`, `price_changed`,
  `not_entitled` and the rest are the API working — FR-33 makes them a documented shape
  precisely because they are expected. A 404 is a client's problem.
- **Downloads.** `download` is the highest-volume event on the platform and it means an
  entitlement already granted is being used. It is a metric, not news.
- **Crons that ran normally.** A sweep that paid, a reconcile that matched, a rescan that
  found nothing. There is no such thing as a healthy notification you read; you learn to
  swipe them away, and then you swipe away the one that mattered. Success is visible on
  `/admin` when you go and look.

The test for all four: would a person do something differently on reading it? If not, it
belongs in the `event` table and on `/admin/activity`, which have both.

## Adding a kind

Four steps, in this order:

1. Add the variant to the `AdminEvent` union in `lib/notify/index.ts`. **Append** — like
   `EventName` in `lib/events.ts`, a reordered union is a merge conflict for nothing.
2. Add its case to `formatAdminEvent`. It is a pure function of the event, which is what
   makes the message testable without a network.
3. Call `notifyAdmin` from the one place the thing actually happens, next to the `record()`
   that already logs it. If there is no `record()` there, add that first — the `event`
   table is the durable log and Telegram is the nudge, never the other way round.
4. Add the formatter test. It costs a line and it is what catches an unescaped slug and a
   buyer address that crept into a message.

Before you write it, ask what an operator would do about it. If the honest answer is
"nothing, but it is nice to know", the previous section is where it belongs.
