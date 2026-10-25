/**
 * GET /dashboard/wallet — bind or change the payout address (FR-1, FR-5, FR-26).
 *
 * This page is where a GitHub identity becomes a creator. `creator.payout_address` is
 * NOT NULL and every payout goes to it with no `to` parameter anywhere, so the row is
 * not written until an address has been *proved* — a signature over a challenge this
 * server issued, not a string typed into a box.
 *
 * With JavaScript off it is two round trips, which is the honest shape of the problem:
 * we cannot issue a challenge for an address we have not been told yet.
 *
 *   1. POST the address → the server mints a nonce and re-renders with the exact bytes.
 *   2. Sign those bytes in a wallet, paste the signature, POST it back.
 *
 * With JavaScript on and a browser wallet, it is one button (`BindWallet`): connect,
 * fetch the challenge, sign, POST — the same three fields as the manual path, which
 * stays underneath for anyone binding a hardware or remote wallet by hand.
 */

import type { Metadata } from "next";
import { BindWallet } from "@/app/_components/bind-wallet";
import { Notice } from "@/app/_components/notice";
import { REBIND_DELAY_HOURS } from "@/lib/auth/step-up";
import { paymentChain } from "@/lib/env";
import { currentCreator, currentSession, signInPath } from "@/lib/web/current";
import { challengeByNonce } from "@/lib/web/loaders";
import { formatDateTime } from "@/lib/web/manifest-view";
import { chainInfo, explorerAddressUrl } from "@/lib/web/wallet-checkout";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Wallet" };
export const dynamic = "force-dynamic";

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ address?: string; nonce?: string; new?: string; ok?: string; error?: string }>;
}) {
  const { address, nonce, ok, error } = await searchParams;
  const queued = (await searchParams).new;

  const session = await currentSession();
  if (!session) redirect(signInPath("/dashboard/wallet"));
  const current = await currentCreator();

  const challenge = nonce ? await challengeByNonce(nonce) : null;
  const bound = current?.creator.payout_address ?? null;
  const pending = current?.creator.pending_payout_address ?? null;

  const chain = paymentChain();
  const chainName = chainInfo(chain.chainId).name;
  const addressLink = (address: string) => {
    const url = explorerAddressUrl(chain.chainId, address);
    return url ? (
      <a href={url} rel="noopener noreferrer" target="_blank" className="computed">
        {address}
      </a>
    ) : (
      <span className="computed">{address}</span>
    );
  };

  return (
    <main>
      <h1>Wallet</h1>
      <Notice ok={ok} error={error} />

      {bound ? (
        <>
          <dl>
            <dt>Payout address</dt>
            <dd className="wrap">
              {addressLink(bound)} <span className="muted">on {chainName}</span>
            </dd>
            <dt>Mode</dt>
            <dd>
              {current?.creator.wallet_mode === "custodial"
                ? "custodial — created for you at sign-up"
                : "your own wallet, bound by signature"}
            </dd>
            {pending ? (
              <>
                <dt>Pending</dt>
                <dd className="wrap" data-status="warn">
                  {addressLink(pending)} — effective {formatDateTime(current?.creator.rebind_effective_at)}
                </dd>
              </>
            ) : null}
          </dl>
          <p className="written measure">
            Every sweep goes to this address. The ledger is on <a href="/dashboard/earnings">Earnings</a>.
          </p>
        </>
      ) : (
        <p className="written measure">
          Signed in as <span className="computed">{session.github.login}</span>. One thing is missing before you have an account: an
          address to be paid at. Every payout goes to the address bound here and there is no parameter anywhere for sending one
          somewhere else, so it has to be an address you can sign from — an exchange deposit address will not work.
        </p>
      )}

      {challenge && address ? (
        <section>
          <h2>Sign this</h2>
          <p className="written measure">
            Sign these exact bytes with the wallet holding <span className="computed">{address}</span>, then paste the signature below.
            The challenge is single use and expires at <span className="computed">{formatDateTime(challenge.expires_at)}</span>.
          </p>
          {queued ? (
            <p className="written measure">
              You are signing from the address bound now, to authorise payouts moving to <span className="computed">{queued}</span> in{" "}
              {REBIND_DELAY_HOURS} hours. That is the point of the delay: an API key alone cannot do this.
            </p>
          ) : null}
          <form method="post" action={bound ? "/dashboard/wallet/rebind" : "/dashboard/wallet/bind"} id="sign-form">
            <input type="hidden" name="address" value={address} />
            {queued ? <input type="hidden" name="new_address" value={queued} /> : null}
            <input type="hidden" name="nonce" value={nonce} />
            <input type="hidden" name="message" value={challenge.message} />
            <div className="field">
              {/* Not a `<label>`: `<pre>` is not a labelable element, so `for` would
                  associate with nothing and the caption would be read as loose text. */}
              <span className="field-label">Message</span>
              <pre id="challenge-message">
                <code>{challenge.message}</code>
              </pre>
            </div>
            <div className="field">
              <label htmlFor="signature">Signature</label>
              <textarea
                id="signature"
                name="signature"
                rows={3}
                required
                placeholder="0x…"
                spellCheck={false}
                aria-describedby="signature-help"
              />
              <small id="signature-help">
                An EIP-191 <code>personal_sign</code> signature over the message above, from that address.
              </small>
            </div>
            <BindWallet mode="sign" address={address} message={challenge.message} signatureFieldId="signature" />
            <p className="actions">
              <button type="submit">{bound ? `Queue the change (${REBIND_DELAY_HOURS}h delay)` : "Bind this address"}</button>
              <a href="/dashboard/wallet">Start over</a>
            </p>
          </form>
        </section>
      ) : (
        <section>
          {bound ? (
            <details>
              <summary>
                <span className="label">Change the payout address</span>
                <span className="computed">{REBIND_DELAY_HOURS}h delay</span>
              </summary>
              <p className="written measure">
                A change takes {REBIND_DELAY_HOURS} hours to land. Nothing announces it, so look here if you did not ask for one. Sweeps keep going to the
                current address until then — that delay is the whole defence against someone who has taken your API key.
              </p>
              <AddressForm bound={bound} />
            </details>
          ) : (
            <>
              <h2>Bind a payout address</h2>
              <p className="written measure">
                Connect the wallet you want to be paid at and sign one message. That is the whole thing.
              </p>
              <BindWallet mode="bind" action="/dashboard/wallet/bind" />
              <details>
                <summary>
                  <span className="label">No browser wallet? Bind by hand</span>
                </summary>
                <AddressForm bound={bound} />
              </details>
            </>
          )}
        </section>
      )}

    </main>
  );
}

/**
 * The by-hand path: type an address, get a challenge, sign it elsewhere. For a hardware
 * wallet, an air-gapped signer, or a browser with no extension. Real, and works with
 * scripting off — and closed by default on first bind because almost nobody needs it.
 */
function AddressForm({ bound }: { bound: string | null }) {
  return (
    <form method="post" action="/dashboard/wallet/challenge">
      <div className="field">
        <label htmlFor="address">{bound ? "New address" : "Address"}</label>
        <input
          id="address"
          name={bound ? "new_address" : "address"}
          required
          pattern="0x[0-9a-fA-F]{40}"
          placeholder="0x0000000000000000000000000000000000000000"
          spellCheck={false}
          autoComplete="off"
        />
        <small>
          {bound
            ? "Where payouts should go from now on. The next step asks the address bound now to sign off on the change."
            : "An EVM address on Base that you can sign from. The next step gives you a challenge to sign, which is how we know it is yours."}
        </small>
      </div>
      <p className="actions">
        <button type="submit">Get a challenge</button>
      </p>
    </form>
  );
}
