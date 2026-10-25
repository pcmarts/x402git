# x402 upstream watch

The protocol this product sells over belongs to someone else. `x402-foundation/x402`
merges dozens of commits a week across seven SDKs, and most of it is irrelevant to us —
new chains, other languages, facilitator internals. This file is the filter: what we run,
what we adopted, what we declined and why, and what is worth a second look when it
matures. It exists so the next review is a diff and not a re-read.

Run the check:

```
npm run x402:check              # versions, changelogs above ours, new extensions/schemes, TS commits
npm run x402:check -- --record  # same, then move the watermark in scripts/x402-upstream.state.json
```

Exit status is 1 when there is news, 0 when there is not. The watermark file also holds
the list of extension and scheme docs seen at the last review; a new file appearing under
`docs/extensions/` or `docs/schemes/` upstream is the one signal that can change the
*product* rather than the dependency, so the script calls it out separately.

## Where we stand — 10 Sep 2026

| Package | Version | Note |
| --- | --- | --- |
| `@x402/core` | 2.25.0 | Latest. Bumped from 2.24.0 in this review |
| `@x402/evm` | 2.25.0 | Latest |
| `@x402/fetch` | 2.25.0 | Latest, dev-only (the e2e harnesses and the snippet we publish) |
| `@coinbase/x402` | 2.1.0 | Latest, but last published 23 Dec 2025. Used for one call, `createFacilitatorConfig` |

The 2.25.0 bump was clean: `npm run typecheck` and all 1371 tests pass. Three notes from
its changelog were checked against our code, and none of them needed a change:

- **`buildPaymentRequirements()` now throws** when no scheme server is registered for the
  requested scheme and network, instead of answering 402 with an empty `accepts`. We
  register `eip155:*` in `lib/x402/server.ts#resourceServer`, which covers both Base
  mainnet and Base Sepolia, so every network we price on has a scheme server.
- **Eager facilitator sync now exits the process** on a permanent capability or
  route-configuration error. We deliberately never call `initialize()` (see the comment on
  `resourceServer`), so this path is not reachable — worth remembering if we ever add it,
  because a process exit inside a serverless function is a cold start, not a crash report.
- **`extensionResponses` is now a server-internal sidechannel**, decoded from the
  facilitator's `EXTENSION-RESPONSES` header and stripped from the buyer-facing
  `PAYMENT-RESPONSE`. We do not read it yet. It is how the Bazaar reports whether a
  listing was indexed, which matters only if we adopt the extension below.

`@coinbase/x402` is the one dependency that looks stale rather than settled. It is a thin
shim over CDP's facilitator auth and has not been republished in nine months. If CDP
changes how it authenticates `verify`/`settle`, that shim is where it breaks, and the
replacement is our own JWT signing in `facilitatorConfig()`.

## The extension surface, judged against this product

Upstream ships eight extension docs and four schemes. Our position on each:

| Capability | Status | Why |
| --- | --- | --- |
| `bazaar` (discovery) | **Adopted 16 Sep 2026** | `@x402/extensions` 2.25.0; declared per listing in `lib/x402/bazaar.ts`, no `routeTemplate`. Indexed on first echoing settlement — see docs/agent-discovery.md |
| `offer-receipt` | **Candidate** | Signed offers on the 402 and signed receipts on the 200. Portable proof of purchase, which is adjacent to the quality-signal differentiator and to `/receipts/[id]` |
| `payment-identifier` | **Candidate, small** | Buyer-side idempotency for a paid call. `lib/idempotency.ts` covers `POST /api/creators` only; an agent retrying a paid `GET /api/r/...` has nothing but our nonce `UNIQUE` to save it |
| `sign-in-with-x` | Watch | Standard wallet auth. We have our own challenge/signature pair (`/api/auth/challenge`). Aligning would let a generic agent wallet authenticate without reading our docs; it is not a gap today |
| `builder-code` | Declined for now | Ecosystem attribution tags on payments. D6 makes the 10% seller-side fee our only revenue mechanism, and this does not change it |
| `eip2612-gas-sponsoring`, `erc20-approval-gas-sponsoring` | Not applicable | EIP-3009 `transferWithAuthorization` already means the buyer pays no gas. These cover tokens that lack 3009; USDC on Base does not |
| `upto` scheme | Watch | Usage-metered payment. Nothing in the PRD is metered — a purchase is a snapshot at a price |
| `batch-settlement` scheme | Watch | Amortises settlement across many small payments. Interesting only at a volume we do not have; gained a `minDeposit` hint on 7 Sep |
| `auth-capture` scheme | Watch | Client-side only upstream so far |
| Non-EVM chains (Cardano landed 9 Sep, plus SVM, Stellar, TON, XRPL, …) | Declined | The PRD pins Base and USDC. Revisit only with a buyer who cannot pay on Base |
| `@x402/mcp` package | Watch | We hand-roll the MCP payment shape in `lib/mcp/server.ts` for a reason: the price is per-buyer and the server never holds a key. Upstream's wrapper has since gained failure-path settlement (a failed tool call cancels or refunds rather than keeping the deposit) and honours `maxTimeoutSeconds` for tool timeouts. Worth comparing when our paid tool set grows |

## Bazaar — the one finding with product consequences

The facilitator we settle mainnet through already serves the discovery index:

```
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
```

It answers 200 with 14,202 resources. Not one of them is ours. A resource appears there
by declaring the `bazaar` extension on its priced route, and each entry carries the
`accepts` terms, an input/output example, and — this is the part that should interest us —
a `quality` block:

```json
"quality": { "l30DaysTotalCalls": 1084, "l30DaysUniquePayers": 1077, "lastCalledAt": "2026-09-10T18:48:34.709Z" }
```

That is a usage signal computed by the facilitator from settlements, which is the one
kind of trust metric a competitor cannot fabricate with `Math.random()` (see
`docs/research/Battle Test.md`). Two separate opportunities, and they should not be
confused:

1. **Get listed (sell side).** Every published listing becomes discoverable to any agent
   that queries the index, without knowing x402git exists. This is the same argument as
   `docs/agent-discovery.md`, aimed at a surface we do not currently publish to. The work
   is not a one-liner: we do not use the static-price middleware, so the declaration has
   to be attached where we build requirements (`lib/core/access.ts` → `lib/x402/server.ts`),
   and the Bazaar wants a `routeTemplate` that survives the facilitator's
   `matches_resource` check — 2.25.0 fixed exactly that for wildcard registrations, and
   our resource path is `/api/r/[owner]/[slug]`. It needs `@x402/extensions`, which we do
   not yet depend on.
2. **Query the index (buy side).** A "what else can my agent pay for" surface. Out of
   scope for the PRD as written; noted so the option is not rediscovered as a new idea.

Neither is a decision this file can make. Both belong in `docs/BACKLOG.md` first and the
PRD second, per the working agreement.

## Review log

- **16 Sep 2026** — adopted the `bazaar` extension (sell side, opportunity 1 below) after
  the discovery research in `docs/research/Agent Discovery Channels.md`. Added
  `@x402/extensions@2.25.0` to match core. The facilitator catalogues only on a settlement
  whose payload echoes the declaration; `@x402/core` 2.x clients do that unprompted, the
  buy-a-repo skill now tells hand-rolled signers to. The platform does not seed the index
  (DECISIONS.md, 16 Sep); `npm run bazaar:check` reports each listing's state.
  Opportunity 2 (querying the index) is still out of scope.

- **10 Sep 2026** — first pass. Bumped core/evm/fetch 2.24.0 → 2.25.0 (typecheck and
  1371 tests green), reviewed the 2.25.0 breaking notes against our code, inventoried the
  eight extensions and four schemes above, and confirmed the CDP Bazaar index is live and
  does not contain us. Added `scripts/x402-upstream-check.mjs` and this file.
