# Reporting abuse

Version 2026-09-13.

Write to **[abuse@x402git.com](mailto:abuse@x402git.com)**. A person reads it.

We acknowledge every report within **24 hours** and act on it within **72 hours**. That
applies to everything on this page: copyright and other intellectual-property claims,
malware, leaked credentials, sanctions concerns, and anything else about a listing that
should not be for sale.

## What to send

Tell us which listing, and why. A report we can act on names:

1. The listing URL, and the version if only one version is affected.
2. What is wrong, specifically enough that we can check it ourselves.
3. How to reach you.

For an intellectual-property claim, we also need the things the law requires of a notice:

1. Identification of the work you say has been infringed.
2. Identification of the material on this service you say infringes it, precise enough
   for us to find it — a listing URL is usually enough.
3. Your contact details: name, address, telephone number and email.
4. A statement that you believe in good faith that the use is not authorised by the
   rights holder, its agent, or the law.
5. A statement that the information in your notice is accurate, and — under penalty of
   perjury — that you are authorised to act for the rights holder.
6. Your physical or electronic signature.

Send a notice that is missing these and we will come back to you for them, which costs
you time. Send one you know to be false and you may be liable for damages, including
costs and legal fees.

## What we do about it

1. We acknowledge within 24 hours and act within 72.
2. If we uphold the claim we stop the listing being sold. Depending on what was wrong we
   may also revoke buyers' access to it and refund what they paid, out of the money held
   back from the creator. **A takedown is the only circumstance in which a buyer loses
   access to something they bought.**
3. We tell the creator what was claimed and who claimed it, so they can respond.
4. **Two upheld notices retire a creator's account.** That is our repeat-infringer
   policy and it is not discretionary.

## If you are the creator and you think we got it wrong

Reply to us with a counter-notice. It should identify the material we removed and where
it was, state under penalty of perjury that you believe in good faith it was removed as
a result of mistake or misidentification, give your name, address and telephone number,
and consent to the jurisdiction of the appropriate court. We may restore the material
unless the complainant tells us they have filed suit.

## Designated agent

**None is registered.** This service has no designated agent on file with the US
Copyright Office. It is operating without one by choice rather than by oversight, and
saying so is more use to you than a page that implies otherwise.

Nothing else here is conditional on that.
**[abuse@x402git.com](mailto:abuse@x402git.com)** reaches us, and a notice sent to it is
acknowledged within 24 hours and acted on within 72 — whether or not it is framed as a
formal DMCA notice, because we will not ask you to follow a process we have not
registered for. If an agent is registered later, this section will name it and give its
address.

## Reporting something that is not an IP claim

The same address, and the same timelines. We are particularly interested in:

- **Credentials in a listing** — an API key, a token or a private key committed to a
  repository we are selling. Every release is scanned for these before it can be sold,
  but a scanner is not a guarantee. Tell us and we will pull it.
- **Malicious code.** We scan for known-vulnerable dependencies, not for malice.
- **A listing that is not the creator's to sell**, which is an IP claim, but you do not
  have to frame it as one for us to look.

If you are reporting a vulnerability in this service itself rather than in a listing,
the same address reaches us. Tell us what you found and how to reproduce it, and give us
a reasonable chance to fix it before you publish.

## The webhook we send creators

A creator can register an abuse contact URL. When something on this page happens to one of
their listings we POST it there, so a creator does not have to be reading email to find
out. Four events are sent:

- **`release.failed`** — a release did not pass the scan and is not for sale.
- **`release.compromised`** — a release that already passed now depends on something a
  vulnerability database calls malware. The listing keeps selling until a person decides
  otherwise; this is the notice that a person should.
- **`listing.takedown`** — we upheld a notice and stopped the listing being sold.
- **`payout.sent`** — money left for the creator's payout address.

The request carries two headers:

- `x402git-event` — the event name above, so a receiver can route without parsing.
- `x402git-signature` — `sha256=<hex>`, an HMAC-SHA256 over the **exact bytes we POSTed**,
  keyed with the shared secret. Verify it before you trust the body, and verify it against
  the raw bytes: re-serialising the JSON first will give you a different string and a
  signature that does not match.

The body is `{ event, listing_id, version, code, docs_url, timestamp }` and carries nothing
confidential — the signature proves it came from us, not that it needs hiding. We do not
follow redirects, the URL must be `https` and resolve to a public address, and we give up
after 5 seconds.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(header ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
```
