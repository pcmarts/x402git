# Buyer terms

Version 2026-09-03.

These terms apply when you buy access to a listing. You accept them by paying. There is
no account to create: a purchase belongs to the wallet address that paid for it.

## 1. What you are buying

1. **You are buying access to one version of one listing**, delivered as a snapshot of
   the creator's repository at that version. You receive a download link that expires in
   minutes; the version itself stays yours.
2. **A version you have bought stays fetchable.** Ask again with a signature from the
   wallet that paid and you get it back, for as long as the platform runs. A creator
   cannot take it away by retiring the listing or deleting their repository.
3. **You are buying from the creator, not from us.** We host the listing, take payment,
   check what we say we check in section 4, and deliver the bytes. What the code does is
   the creator's work.
4. The bytes you receive are the exact bytes that were scanned, identified by a SHA-256
   hash shown on the listing and on your receipt. Check it if it matters to you.

## 2. Money

1. **Payment is in USDC on Base and it is final.** A settled transaction cannot be
   recalled by us or by anyone. Access is granted only after settlement returns a
   transaction hash, so a payment that does not settle buys nothing and charges nothing.
2. You pay the listed price. The creator receives 90% of it; the platform keeps 10%.
3. **The update price is fixed at your purchase and never gets worse.** If the creator
   later raises it, you are charged what you were quoted. If they lower it, you are
   charged the lower amount. If updates were free when you bought, they are free for you
   forever, whatever changes afterwards.
4. Network fees are paid by whoever submits your payment to the chain, not added to your
   price.

## 3. Refunds

1. **There is no buyer-initiated refund.** Decide before you pay.
2. The one exception is a takedown: if we uphold an intellectual-property complaint
   against a listing, we may refund what you paid and revoke your access to it. That is
   the only circumstance in which a purchase is reversed, and the only circumstance in
   which you lose access to something you bought.
3. A buyer-initiated refund window is planned but is not part of these terms and does not
   exist today.

## 4. What we check, and what we do not

1. Every release is automatically scanned for committed secrets and for dependencies with
   known published vulnerabilities. A release that fails is not sold.
2. **That is not a security review, a quality review, or a safety review**, and it cannot
   find a vulnerability nobody has published or code that is simply bad. Read what you
   buy before you run it.
3. The manifest on a listing page is computed from the creator's repository with no input
   from them. Anything the creator wrote is shown to you badged as self-reported. Treat
   the two differently.
4. We do not verify that a listing does what its description says.

## 5. Licences

1. **The licence comes from the creator and passes through to you.** We grant you nothing
   beyond delivery of the bytes, and we cannot give you rights the creator did not have.
2. Every listing shows a computed licence signal. A listing may be sold while that signal
   says the licence is missing or unrecognised — the signal informs you, it does not gate
   the sale. **If your use depends on the licence, read it before you buy.**
3. Keep the attribution that came with the artifact. Whatever the creator's licence
   requires of you, it still requires.

## 6. Privacy

1. Creators never see your wallet address or your transaction hash.
2. **Your payment is public on-chain**, as every such payment is. Anyone can see a
   transfer to the platform's receiving address, its amount and its time. We do not
   publish who bought what, but we cannot make a public blockchain private.
3. A listing may show how many distinct wallets have bought it. No surface attributes a
   purchase to an address, a wallet, a country or a time.
4. Your address is checked against public sanctions lists before payment settles.

## 7. Using the service honestly

Do not attempt to obtain a listing you have not paid for, share a download link so others
can avoid paying, or resell access in a way the creator's licence does not permit. We may
refuse service to an address that does.

## 8. No warranty

The service and everything sold through it are provided as is, with no warranty of any
kind. We are not liable for indirect or consequential loss, and we are not liable for
what a creator's code does when you run it. Nothing here limits a liability that cannot
be limited by law.

## 9. Changes

We may change these terms. A change never applies retroactively to a purchase already
made: what bound your purchase is the version in force when you paid, and the prices
stamped on it do not move.
