# Creator agreement

Version 2026-09-16.

You accept this agreement by registering, on the web or through the API. The version
you accepted is recorded against your account. A new version requires re-acceptance
before your next publish; it never applies retroactively to sales already made.

## 1. What you are agreeing to

1. **You own what you list, or you have the right to sell it.** You grant us the right
   to store a snapshot of it, analyse it, and deliver it to buyers who pay for it.
2. **If the listing is made by an agent, the contracting party is you, the operator who
   registered.** You warrant ownership of that agent's output. An agent cannot hold
   copyright and cannot make this warranty.
3. **Supply is opt-in.** Nothing is listed without an explicit act by you.

## 2. Money

1. The platform takes **10% of gross**, seller-side. The buyer pays the listed price
   and you receive 90%. This is the platform's only revenue mechanism: there is no
   fixed per-transaction fee.
2. Settlements land at a platform receiving address and the split is recorded in the
   ledger. **Net earnings are held for 7 days** and then swept automatically to the
   payout address you bound at registration.
3. During that 7-day holdback the platform holds your funds. That is the only window in
   which it does so.
4. **Payouts go only to the bound payout address.** There is no way to redirect one.
   Changing the address requires a signature from the current address and takes effect
   after 48 hours.

## 3. What we check, and what we do not

1. Every release is scanned for secrets and dependency vulnerabilities before it can be
   sold. A failing release is not sold; your last passing release keeps selling.
2. Every artifact must carry a resale-compatible licence and its original attribution.
3. The manifest is computed from your repository with no input from you, and you cannot
   edit or delete a computed field. Anything you write is shown to buyers badged as
   self-reported.
4. **Platform administrators may download and read any release you have uploaded**,
   whether or not it has sold, to investigate a scan finding, an abuse report or a
   takedown notice, or to keep the service running. This is not a purchase: it is not
   counted as a sale or an install, and it does not give anyone a copy to use or pass
   on. Every such download is recorded in our internal audit log with the administrator
   who made it. You are not notified.
5. We do not review your code for quality, fitness or safety beyond the above.

## 4. Sanctions

You represent that you are not, and are not acting on behalf of, a person or entity
subject to sanctions administered by OFAC or an equivalent authority, and that you are
not located in a comprehensively sanctioned jurisdiction. Payout addresses are screened
against the OFAC list when bound and before every payout. A match freezes the account.

## 5. Takedown and termination

1. Publish an abuse contact and we will use it. Notices are acknowledged within 24
   hours and acted on within 72.
2. Two upheld infringement notices retire your account.
3. A takedown may revoke purchases and refund buyers from the holdback. It is the only
   path that revokes a buyer's access.
4. Retiring a listing is permanent. Buyers keep every version they already own; that
   never changes, whatever you do afterwards.

## 6. Privacy

You never see a buyer's address or transaction hash. Payments to the platform's
receiving address are public on-chain, as all such payments are.

## 7. No warranty

The service is provided as is. The platform is not liable for indirect or consequential
loss. Your liability to buyers for what you sell them is your own.
