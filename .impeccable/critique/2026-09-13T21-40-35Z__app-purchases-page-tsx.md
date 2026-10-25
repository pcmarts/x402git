---
target: pre-wallet-connect state of /purchases
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-09-13T21-40-35Z
slug: app-purchases-page-tsx
---
Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | One busy label ("Opening your wallet…") covers two wallet prompts; shown on a disabled grey button; not announced to AT |
| 2 | Match System / Real World | 3 | Page copy is plain, but the signature sheet the buyer reads says `purpose: wallet_ownership` + nonce; "fetchable" is dialect |
| 3 | User Control and Freedom | 3 | Retry works; focus dropped to body when the button disables and not restored on error |
| 4 | Consistency and Standards | 3 | Mirrors /signin; three column widths (30/22/26rem); rejection copy is checkout copy |
| 5 | Error Prevention | 2 | Nothing pre-empts the personal_sign moment; phone user presses Connect before learning the browser can't reach a wallet |
| 6 | Recognition Rather Than Recall | 1 | "The wallet you paid with" is pure recall; no chain/brand/address cue; agent route hidden once JS runs |
| 7 | Flexibility and Efficiency | 2 | No mobile wallet deep links; API path only in the no-JS branch |
| 8 | Aesthetic and Minimalist Design | 3 | Genuinely spare; lede reads as a pitch to someone who already bought |
| 9 | Error Recovery | 3 | Alert is announced and names the way out; "Nothing was charged" answers the wrong question; column re-centres on retry |
| 10 | Help and Documentation | 2 | `GET /api/entitlements` + Docs only in the `!mounted` branch; nothing explains the signature |
| **Total** | | **24/40** | **Fair** |

## Design Specificity Verdict
A well-set generic: authored in copy, interchangeable in shape. Tokens are the system's and it shares a family with /signin, but strip the wordmark and it is the stock "connect wallet" gate. Nothing of the ledger (columns, tabular numerals) appears before connect. The specific parts are the lede's three "after" clauses and "signed fresh and lasts five minutes".

Deterministic scan: 0 findings (CLI over page.tsx + purchases.tsx, exit 0; in-page detector reported "No anti-patterns found"). No horizontal overflow at 1280 or 390. Button 352x44, 5.83:1; small print 4.97:1 (AA pass, AAA fail); focus ring present (paper gap + ink ring); reduced-motion override applies; server HTML carries h1, lede, no-JS text and privacy note; "Connect wallet" is client-only.

## Priority Issues
- [P0] The personal_sign step is unexplained at the moment it matters. Connect fires eth_requestAccounts then personal_sign under one label. Fix: add a "signing" phase in app/_components/purchases.tsx and a role="status" line: "Now sign the message your wallet shows. It proves you hold this address — no transaction, nothing moves, nothing is charged."
- [P1] The agent/API route (`GET /api/entitlements`, Docs) lives only in the !mounted branch. Fix: move it into the server-rendered small print in app/purchases/page.tsx.
- [P1] No-wallet state says "Install one" to a phone user who has one. Fix: "This browser can't reach a wallet." + deep links that open this page in Coinbase Wallet / MetaMask; downloads become secondary.
- [P2] Column re-centres on every state change (justify-content: center), so the button moves at retry time. Fix: pin with flex-start + top padding or reserve a status slot.
- [P2] Rejection copy borrowed from checkout ("Nothing was charged"); busy state uses disabled (grey) and drops focus. Fix: local "Nothing was signed." message; aria-busy instead of disabled; restore focus on error.
- [P3] "fetchable" is dialect; metadata.description is the better lede.

## Persona Red Flags
- Paul (buyer-operator): agent purchases invisible here; API route hidden once JS runs; multiple wallets means guessing, each guess costs connect + sign.
- First-timer, Coinbase Wallet on phone: in Safari told to install an app she has; no deep link; in the wallet browser a bare signature request with no warning it is free.
- Keyboard/screen reader: five tabs to the control, no skip link; label change unannounced; focus lost on disable; populated role=status inserted late may not announce.

## Minor Observations
- Three widths in one door (30rem lede, 22rem button/rule, 26rem alert).
- No-wallet paragraphs take the 68ch measure, not the 30rem cap.
- Challenge message format is shared by four purposes and asserted in tests; change the on-page line, not the message.
- Contrast, tap size, reduced motion, noindex all fine.

## Questions to Consider
1. Why a door at all? Print the ledger's empty shape (column heads + one row saying "Connect the wallet you paid with").
2. Is a browser-wallet gate the right primary path for "see what my agents bought"? A pasted address showing counts, with the signature gating only downloads?
3. Could one human line in the challenge text ("Sign to prove you hold this address on X402 Git. No transaction, no cost.") remove the valley?
