# PRD: Session keys — the dashboard stops borrowing the agent's credential

**Status:** Accepted (31 Aug 2026), implemented · **Amends:** PRD Final v1.1 (D11, FR-4, §9, §12, §14.7) · **Date:** 30 Aug 2026 (rev. 31 Aug: reconciled with `session_epoch`)

---

## 1. Problem

A creator who signs in to the dashboard on a new browser, or whose two-week cookie has expired, sees this on `/dashboard`:

> This browser session has no API key, so the buttons that change something are unavailable. Issue a new one — it revokes the previous key.

Every dashboard mutation is an HTTP call to the public creator API with `Authorization: Bearer x4c_live_…` (D9). Only the sha256 of that key is stored, so the plaintext lives in exactly one place: the session cookie that was active when the key was minted. A creator has one key. Re-issuing it revokes it, and anything the creator's agents are running on the old key starts getting `401 invalid_key`.

The dashboard is asking the human to break their own agents in order to click "Publish". That is the wrong trade, and the copy cannot fix it because the trade is real.

The root cause is a conflation. Two different things are proved two different ways:

| Thing | Proof today |
|---|---|
| **Who this creator is** | GitHub OAuth (Rail A) or a wallet signature (Rail B) → sealed session cookie |
| **A programme acting for this creator** | `x4c_live_…` bearer key |

The dashboard has the first and borrows the second. The fix is to stop borrowing.

There is a second, smaller conflation the first one forced into being. Because the cookie carries the agent key in plaintext, migration 1100 added `creator.session_epoch` so that logout and key rotation could revoke outstanding cookies — which means **rotating the agent key signs the creator out of the web everywhere**, and the guards check two things (the cookie's epoch, then the key) to answer one question. Session keys dissolve this too: a revocable per-session row *is* the server-side session record, so the epoch becomes redundant and rotation stops having web side-effects.

## 2. Goal

A signed-in creator can use every dashboard button on any browser, at any time, without ever seeing, re-issuing or rotating their agent API key — with no reduction in the security properties of §14.7, and with D9 (the web app calls the same endpoints an agent does) intact.

## 3. Non-goals

- Changing how agents authenticate. `x4c_live_…` keys, their scopes, `POST /api/auth/rotate-key` and secret-scanning auto-revoke are untouched.
- Multiple *agent* keys per creator. One remains the limit in V0; the table shape below permits more later without a further migration.
- A "show me my key again" feature. Plaintext is still never stored.
- Replacing the bearer model with in-process calls from dashboard route handlers to `lib/core`. Rejected — see §8.

## 4. Decision

**D14 — A creator has two kinds of credential: one long-lived `agent` key, and short-lived `session` keys minted silently on sign-in, one per browser session.** Both are bearer keys accepted by `requireCreator`; both are scoped; neither can move money or destroy data without a wallet signature. Rotating one kind never touches the other.

**The `session` key row is the server-side session record, and `creator.session_epoch` is retired.** The epoch existed only because the stateless cookie carried an irrevocable credential; a session key is revocable by row, so the guards ask one question ("does the presented key resolve to a live row?") instead of two. Logout revokes rows instead of bumping an integer, and `POST /api/auth/rotate-key` stops signing the creator out of the web — which the current code does via `bumpSessionEpoch`, and which would otherwise contradict FR-58 below.

Why this is at least as secure as today:

- The plaintext session key is protected exactly as the agent key is now — AES-256-GCM in the cookie, sha256 at rest. Nothing new is exposed.
- The blast radius of a stolen cookie shrinks. Today it yields the creator's only, indefinitely-lived key. After: a key that expires with the session, is revoked on sign-out, and can be revoked without breaking a single agent.
- Sign-out keeps today's semantics: it revokes **every** session key of the creator (the epoch's "orphan all outstanding cookies at once" property), so a captured cookie dies the moment the creator signs out on any device.
- Rotation becomes honest. Rotating the agent key breaks agents on purpose — and now breaks *only* agents. Signing in on a new laptop breaks nothing.
- D11 still holds: the session was established by GitHub OAuth or a wallet signature, which is a stronger proof than the key it mints; the step-up for destructive operations remains a wallet signature (FR-5).

## 5. Functional requirements

- **FR-54** — **Key table.** Keys move out of `creator.api_key_hash` into an `api_key` table (§7). Each row has a `kind` (`agent` | `session`), scopes, `expires_at` (null for `agent`), `revoked_at`, `revoked_reason`, `last_used_at`. `hash` is `UNIQUE`. At most one unrevoked `agent` key per creator, enforced by a partial unique index. `creator.api_key_hash`, `creator.api_key_scopes` and `creator.session_epoch` are dropped in the same migration.
- **FR-55** — **Session keys are minted on sign-in and never shown.** When a session is established for a creator that already exists (OAuth callback on Rail A; a wallet-signed sign-in if one is added later), the server mints a `session` key with the creator's current scopes, `expires_at = session.exp`, stores the hash, and places the plaintext in the sealed cookie. The creator does not see it, is not told about it, and never has a reason to. Binding a wallet on `/dashboard/wallet` (which creates the creator) mints both an `agent` key — shown once, as today — and a `session` key. Invariant: a session with a `creatorId` always carries a key. *Amended 2026-10-25 (DECISIONS.md): binding a wallet mints the `session` key only and goes on to the repo picker; the `agent` key is created on demand from `/dashboard/key`.*
- **FR-56** — **`requireCreator` accepts either kind; web guards accept only `session`.** `requireCreator` resolves the hash to an `api_key` row, rejects `revoked_at IS NOT NULL` and expired rows with `401 invalid_key`, checks scope against the row's scopes as today, and updates `last_used_at` (best effort, not on the request's critical path). Every existing creator endpoint works unchanged for both kinds. The web guards (`currentCreator`, `requireActor`) resolve the cookie's key the same way but additionally require `kind = 'session'` — so a pre-migration cookie still carrying a plaintext *agent* key cannot ride the web session paths, where sign-out would never revoke it. This check replaces `sessionEpochValid`; `lib/web/session-epoch.ts` and the cookie's `epoch` field are deleted.
- **FR-57** — **Session keys die with the session.** Sign-out revokes **all** of the creator's session keys in one write — today's epoch semantics, kept deliberately: it is what makes "sign out on any device" kill a stolen cookie. Expiry is enforced server-side (FR-56) regardless of what the cookie says. A creator's session keys are also revoked when their `agent` key is auto-revoked by secret-scanning (FR-4/FR-35) — a scan hit means an account is under review, and the web session should not outlive that.
- **FR-58** — **Agent-key rotation does not touch session keys, and vice versa.** `POST /api/auth/rotate-key` and the dashboard's "Rotate" act only on the `agent` row — in particular, rotation no longer signs the creator out of the web (the current `bumpSessionEpoch` call in both rotate paths is removed, not ported). Signing in on a new browser only mints a `session` row.
- **FR-59** — **The dashboard never gates on a missing key.** `requireActor` always has a bearer credential when it has a session; the `/dashboard/key?next=` redirect and the `/dashboard` warning are removed. `/dashboard/key` becomes the agent-key page only: it shows the key once at mint, then shows the prefix, created date and `last_used_at`, and offers **Rotate** (revokes the old agent key — stated plainly, as today) and nothing else. *Amended 2026-10-25: with no agent row the page offers **Create key** instead; everything but the key, its dates and that one button sits in a closed disclosure.*
- **FR-60** — **Prefix.** Session keys are `x4s_live_` + 32 base62 chars; agent keys stay `x4c_live_`. Same generator, same scanner pattern (`x4[cs]_live_[0-9A-Za-z]{32}` — the scanner has two copies of the pattern, `lib/scan/secrets.ts` matches both). A leaked session key is distinguishable in logs and in a scan hit. The session *cookie* is already named `x4s` (`x4s.<payload>.<mac>`); the shared stem is fine — the scanner pattern requires `_live_` and cannot match a cookie — but the two are different things and comments should say so. Both prefixes go to GitHub's secret-scanning partner program when that registration happens.
- **FR-61** — **Attribution.** `requireCreator` knows which row authenticated the request, so creator-side mutation *events* (`lib/events` `record()`) gain the key's `kind` — an audit answer to "did a human or an agent retire this listing?". No new columns on domain tables; the `api_key` row's `last_used_at` and `kind` carry the rest. (This is why revoked and expired rows are kept, not deleted — see §7.)

## 6. Journeys after this change

**Returning creator, new laptop (Rail A).** Sign in with GitHub → session established, session key minted silently → `/dashboard` renders with every button live. The agent on the old laptop keeps working. The creator never learns a key was involved.

**Creator wants a key for a script.** `/dashboard/key` → "Rotate" → new `x4c_live_…` shown once, old one dead, warning stated. The browser session they are sitting in is unaffected, because it is on its own key. So is the browser session on their other laptop — today both would be signed out by the epoch bump.

**Agent-only creator (Rail B).** Unchanged. `POST /api/creators` returns `x4c_live_…`; `rotate-key` rotates it. No session key is ever minted for them unless they later bind GitHub and sign in on the web.

**Cookie stolen.** Attacker can do what the creator can do on the dashboard for at most 14 days, cannot move money (FR-26), cannot change the payout address or delete a repo (FR-5). Creator signs out on any device → every session row revoked → the stolen cookie is inert. Agents unaffected.

## 7. Data model (§12 amendment)

```sql
create type api_key_kind as enum ('agent', 'session');

create table api_key (
  id             uuid primary key default gen_random_uuid(),
  creator_id     uuid not null references creator(id) on delete cascade,
  kind           api_key_kind not null,
  hash           text not null unique,
  scopes         text[] not null default '{listings:write,earnings:read}',
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,                    -- null for agent keys
  revoked_at     timestamptz,
  revoked_reason text,                           -- e.g. 'found_in_repository', 'rotated', 'signed_out'
  last_used_at   timestamptz,
  check (kind = 'agent' or expires_at is not null)
);

-- one live agent key per creator
create unique index api_key_one_live_agent
  on api_key (creator_id) where kind = 'agent' and revoked_at is null;

create index api_key_creator_live on api_key (creator_id) where revoked_at is null;

-- Backfill. `creator.api_key_hash` holds either a bare sha256 hex hash or, for keys the
-- scanner already revoked, `revoked:<reason>:<epoch-ms>:<hash>` (lib/auth/api-key.ts's
-- revokeApiKeyByHash trick, which existed because the hash column was NOT NULL UNIQUE
-- and is retired by this table — revocation becomes a plain `revoked_at` write).
-- Revoked keys must land with `revoked_at` set or the partial unique index counts them
-- as live and the backfill can violate it.
insert into api_key (creator_id, kind, hash, scopes, revoked_at, revoked_reason)
  select id, 'agent',
         case when api_key_hash like 'revoked:%' then api_key_hash  -- stays unique as-is; unmatchable by any bearer
              else api_key_hash end,
         api_key_scopes,
         case when api_key_hash like 'revoked:%'
              then to_timestamp(nullif(split_part(api_key_hash, ':', 3), '')::bigint / 1000.0)
              else null end,
         case when api_key_hash like 'revoked:%' then split_part(api_key_hash, ':', 2)
              else null end
  from creator;

alter table creator
  drop column api_key_hash,
  drop column api_key_scopes,
  drop column session_epoch;    -- FR-56: the session key row replaces the epoch
```

Rows are never deleted in V0. There is no cleanup cron to lean on — §9's cron routes (`/api/cron/sweep`, `/api/cron/reconcile`) are the money jobs and should stay that way — and FR-61's audit trail wants the rows anyway. They are one small row per sign-in; revisit only if volume ever says otherwise.

**Deploy note.** Cookies minted before this ships carry the agent key (or no key) and fail FR-56's `kind = 'session'` check, so every existing *web* session is signed out once at deploy. Agents are untouched. This is the honest cutover — the alternative is grandfathering cookies that sign-out can't revoke.

## 8. Alternatives considered

| Option | Why not |
|---|---|
| **Silently rotate the agent key on every sign-in** | Revokes the key the creator's agents hold, invisibly. This is precisely what the current `/dashboard/key` page exists to refuse. |
| **Store the agent key reversibly (encrypted, not hashed) so the dashboard can re-read it** | Turns a DB leak plus a config leak into every creator's key. §14.7 assumes the DB will leak; hashing is the reason that assumption is survivable. |
| **Dashboard route handlers call `lib/core` in-process using the session as the actor** | Fewer moving parts, but it forks authentication: two ways to be a creator, one of which bypasses `requireCreator`, scopes, rate limits and the error catalogue. D9 exists so the API and the site cannot diverge; this is the divergence. |
| **Ask the creator to paste their existing key into the new browser** | They cannot — a key held by an agent on another machine is not in their clipboard, and training people to paste bearer keys into web forms is the wrong reflex to build. |
| **JWT-style self-contained session tokens verified without a DB row** | Not revocable on sign-out or on scan hit without a denylist, which is a table anyway. The row is simpler. |
| **Keep `session_epoch` alongside session keys** | Two server-side revocation mechanisms answering one question, and the epoch's rotation-bump would break FR-58 unless special-cased. The key row is per-credential revocation; the epoch was a coarse stand-in for not having it. |

## 9. Touch list

| Area | Change |
|---|---|
| `PRD Final.md` | D14 added to §5; FR-4 gains "see PRD Session Keys"; §12 references `api_key`; §14.7 notes the two kinds |
| `supabase/migrations/` | New migration per §7 (table, backfill, three column drops) |
| `lib/db/types.ts` | `ApiKeyRow`, `ApiKeyKind`; `CreatorRow` loses `api_key_hash` / `api_key_scopes` / `session_epoch` |
| `lib/auth/api-key.ts` | `generateApiKey(kind)`, prefix per kind, `looksLikeApiKey` matches both; `requireCreator` resolves via `api_key`, enforces `revoked_at` / `expires_at`, bumps `last_used_at`; `revokeApiKeyByHash` becomes a plain `revoked_at`/`revoked_reason` write (the `revoked:` hash-prefix trick dies with the old column) |
| `lib/web/onboard.ts` | `createCreatorFromGithub` mints `agent` + `session`; `reissueApiKey` moves to the `api_key` table |
| `lib/web/oauth-callback.ts` | Existing creator → mint `session` key into the cookie |
| `app/dashboard/wallet/bind/route.ts` | Carry both keys: agent shown once, session into cookie |
| `app/dashboard/key/reissue/route.ts` → `rotate/route.ts` | Rotates `agent` only; no `bumpSessionEpoch`, cookie untouched |
| `app/api/auth/rotate-key/route.ts` | Rotates the `agent` row; the `bumpSessionEpoch` call is removed (FR-58) |
| `app/api/auth/logout/route.ts` | Revokes all the creator's `session` rows instead of bumping the epoch (FR-57) |
| `lib/web/session-epoch.ts` | Deleted; `sessionEpochValid` callers switch to the FR-56 row check |
| `lib/web/current.ts` | `currentCreator` resolves the cookie's key to a live `session` row |
| `lib/web/dashboard.ts` | `requireActor` same row check; drops the `/dashboard/key?next=` branch |
| `app/dashboard/page.tsx` | Remove the warning |
| `app/dashboard/key/page.tsx` | Agent-key page per FR-59 |
| `app/dashboard/[id]/page.tsx` | Remove `disabled = !session.apiKey` and the read-only banner |
| Secret scanner (FR-35) | Both patterns in `lib/scan/secrets.ts` cover `x4[cs]_`; on hit, revoke agent *and* the creator's session keys |
| `lib/web/session.ts` | Comment rewrite; `apiKey` required once `creatorId` is present; `epoch` field removed |
| Tests | `api-key.test.ts` (both kinds, expiry, revocation, one-live-agent index), `oauth-callback.test.ts` (asserts a session key is minted, not `undefined`), `session.test.ts`, logout/rotate tests asserting the FR-57/FR-58 split |
| Docs | `/docs/errors#invalid_key` mentions expired session keys; OpenAPI security scheme description; `x4c_live_` copy in `lib/openapi.ts`, `lib/web/error-recovery.ts`, `lib/web/markdown.ts` |

## 10. Acceptance

1. Sign in on browser A, bind a wallet, note the agent key. Sign in on browser B with the same GitHub account. **B can publish, sync, retire and change pricing without visiting `/dashboard/key`.** The agent key still authenticates `curl`.
2. Rotate the agent key on A. **A's dashboard buttons still work; B's still work** (today both would be signed out — the epoch bump is gone); **the old agent key returns `401 invalid_key`; the new one works.**
3. Sign out on B. **B's cookie, replayed, returns `401 invalid_key` from the API and a redirect to sign-in from the dashboard — and so does A's** (sign-out revokes all session rows, FR-57).
4. Set a session key's `expires_at` to the past in the DB. **Its next request is `401 invalid_key`.**
5. Trigger a secret-scanning hit on the agent key. **Agent key and every session key of that creator are revoked.**
6. Present a valid *agent* key through the web-session path (a hand-built cookie). **The web guards refuse it** (FR-56 `kind = 'session'`).
7. `npm run typecheck`, `npm test`, `npm run check:ssr` pass. The strings "This browser session has no API key" and `session_epoch` no longer exist in `app/` and `lib/`.

## 11. Open questions

- **Session TTL.** 14 days is inherited from `SESSION_TTL_SEC`. With revocable rows it could safely be longer; with silent minting it could be shorter. Leave at 14 days for V0.
- **Per-device sign-out.** FR-57 keeps today's "sign out everywhere" semantics because that is what the epoch did and what the stolen-cookie journey needs. The rows make per-device sign-out (revoke only the presenting cookie's key) possible later, with "sign out everywhere" as the explicit second button — a UX refinement, not a V0 requirement.
- **Rail B creators who never use the web** never get a session row. Fine — zero rows is a valid state everywhere.
