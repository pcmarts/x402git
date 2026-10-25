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
 *
 * Two kinds of wallet since 25 Oct 2026 (HACKMERIDIAN-JOURNEYS rule 1): one EVM address
 * for being paid on Base, one Stellar account for being paid on Stellar, and a creator
 * needs one, not both. A Stellar account is bound from Freighter (`StellarWallet`) with
 * the same challenge, signed as SEP-53. The one Stellar-only step is the trustline (C2
 * step 3): until the account has allowed the asset in Freighter, Horizon says so and this
 * page prints the exact steps, with the issuer to copy, and a Refresh.
 *
 * Once bound, the page is two sections, one per rail, each with its address and one
 * action: add it (live at once: C3 for Stellar, C4 for EVM) or change it (48 hours,
 * signed off by the wallet bound now and typed to confirm: C5). A Stellar-only creator
 * who adds an EVM wallet ends up with the EVM address as the identity and the G… as the
 * Stellar payout address, the same row as an EVM creator who added Stellar.
 *
 * Adding is one button since 25 Oct 2026, ~21:30 (HackMeridian; the founder: "lets not
 * have the confirm the last 6 digits of your evm wallet - a lot of hassle. Do we need to
 * have the stellar wallet confirm? Feels needless."): connect the new wallet, sign once,
 * done. The rail had no money on it, so there is nothing for the other wallet to protect;
 * PATCH /api/creators/me's header has the reasoning and the accepted risk. Changing keeps
 * the sign-off and the six characters, because money is already flowing there.
 */

import type { Metadata } from "next";
import { BindWallet, EvmWallet, StellarWallet } from "@/app/_components/bind-wallet";
import { CopyButton } from "@/app/_components/copy-button";
import { Notice } from "@/app/_components/notice";
import { currentStellarPayoutAddress, inspectStellarPayoutAccount, stellarBindReason } from "@/lib/auth/stellar-binding";
import { REBIND_DELAY_HOURS } from "@/lib/auth/step-up";
import { type StellarRail, paymentChain, stellarRail } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { currentCreator, currentSession, signInPath } from "@/lib/web/current";
import { challengeByNonce } from "@/lib/web/loaders";
import { formatDateTime } from "@/lib/web/manifest-view";
import { chainInfo, explorerAddressUrl } from "@/lib/web/wallet-checkout";
import { addressFamily } from "@/lib/x402/stellar";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Wallet" };
export const dynamic = "force-dynamic";

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ address?: string; nonce?: string; new?: string; ok?: string; error?: string; trustline?: string; refresh?: string }>;
}) {
  const { address, nonce, ok, error, trustline, refresh } = await searchParams;
  const queued = (await searchParams).new;

  const session = await currentSession();
  if (!session) redirect(signInPath("/dashboard/wallet"));
  const current = await currentCreator();

  const challenge = nonce ? await challengeByNonce(nonce) : null;
  const bound = current?.creator.payout_address ?? null;
  const pending = current?.creator.pending_payout_address ?? null;
  const boundFamily = bound ? addressFamily(bound) : null;

  // `stellarRail()` throws on a misconfigured deployment; this page is not the place to
  // surface that, so a broken rail reads as "not offered here" and the Base half still works.
  let rail: StellarRail | null = null;
  try {
    rail = stellarRail();
  } catch {
    rail = null;
  }
  const stellarBound = current ? currentStellarPayoutAddress(current.creator) : null;
  const stellarPending = current?.creator.pending_stellar_payout_address ?? null;

  // The Refresh on the trustline steps (C2 step 3): read Horizon again for that account.
  const trustlineCheck = rail && trustline && refresh === "1" ? await checkTrustline(trustline) : null;

  const chain = paymentChain();
  const chainName = chainInfo(chain.chainId).name;
  const addressLink = (value: string) => {
    const family = addressFamily(value);
    const url = family === "stellar" && rail ? stellarExplorerUrl(rail.network, value) : family === "evm" ? explorerAddressUrl(chain.chainId, value) : null;
    return url ? (
      <a href={url} rel="noopener noreferrer" target="_blank" className="computed">
        {value}
      </a>
    ) : (
      <span className="computed">{value}</span>
    );
  };

  return (
    <main>
      <h1>Wallet</h1>
      <Notice ok={ok} error={error} />

      {rail && trustline ? <TrustlineSteps address={trustline} asset={rail.asset} check={trustlineCheck} /> : null}

      {bound ? (
        <p className="written measure">
          Each sale is paid out on the rail it was bought on, to the wallet below for that rail. The ledger is on <a href="/dashboard/earnings">Earnings</a>.
        </p>
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
                placeholder={addressFamily(address) === "stellar" ? "base64…" : "0x…"}
                spellCheck={false}
                aria-describedby="signature-help"
              />
              <small id="signature-help">
                {addressFamily(address) === "stellar"
                  ? "A SEP-53 signature over the message above from that Stellar account, base64-encoded (your wallet's signMessage, or the x402git-stellar CLI)."
                  : "An EIP-191 personal_sign signature over the message above, from that address."}
              </small>
            </div>
            {addressFamily(address) === "evm" ? <BindWallet mode="sign" address={address} message={challenge.message} signatureFieldId="signature" /> : null}
            <p className="actions">
              <button type="submit">{bound ? `Queue the change (${REBIND_DELAY_HOURS}h delay)` : "Bind this address"}</button>
              <a href="/dashboard/wallet">Start over</a>
            </p>
          </form>
        </section>
      ) : (
        <section>
          {bound ? (
            <>
              <h2>EVM wallet, paid on {chainName}</h2>
              {boundFamily === "evm" ? (
                <>
                  <dl>
                    <dt>Paid in USDC at</dt>
                    <dd className="wrap">{addressLink(bound)}</dd>
                    {pending ? (
                      <>
                        <dt>Pending</dt>
                        <dd className="wrap" data-status="warn">
                          {addressLink(pending)} — effective {formatDateTime(current?.creator.rebind_effective_at)}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  <details>
                    <summary>
                      <span className="label">Change the EVM wallet</span>
                      <span className="computed">{REBIND_DELAY_HOURS}h delay</span>
                    </summary>
                    <p className="written measure">
                      A change takes {REBIND_DELAY_HOURS} hours to land. Nothing announces it, so look here if you did not ask for one. Payouts on {chainName} keep going to the
                      current address until then — that delay is the whole defence against someone who has taken your API key.
                    </p>
                    <AddressForm bound={bound} />
                  </details>
                </>
              ) : (
                <>
                  {pending ? (
                    <dl>
                      <dt>Pending</dt>
                      <dd className="wrap" data-status="warn">
                        {addressLink(pending)} — effective {formatDateTime(current?.creator.rebind_effective_at)}
                      </dd>
                    </dl>
                  ) : (
                    <p className="written measure">Agents paying on {chainName} can&apos;t buy your listings yet. Add an EVM wallet to accept USDC.</p>
                  )}
                  {!pending ? (
                    <details>
                      <summary>
                        <span className="label">Add an EVM wallet</span>
                        <span className="computed">live at once</span>
                      </summary>
                      <p className="written measure">
                        Connect your EVM wallet (MetaMask, Coinbase Wallet…) and sign one message. Stellar payouts keep going where they go now. From then on,
                        changing either wallet is signed off by the EVM wallet.
                      </p>
                      <EvmWallet action="/dashboard/wallet/evm" />
                    </details>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <>
              <h2>Bind a payout address</h2>
              <p className="written measure">
                Connect the wallet you want to be paid at and sign one message. That is the whole thing.
              </p>
              <h3>EVM wallet, paid on {chainName}</h3>
              <BindWallet mode="bind" action="/dashboard/wallet/bind" />
              {rail ? (
                <>
                  <h3>Stellar wallet, paid on Stellar</h3>
                  <p className="written measure">
                    Freighter, Hana, HOT, xBull, Lobstr and more. Paid in {rail.asset.code}. Your wallet has to allow {rail.asset.code} first; if it does not yet,
                    the next step tells you exactly what to add.
                  </p>
                  <StellarWallet mode="bind" action="/dashboard/wallet/bind" networkPassphrase={rail.passphrase} />
                </>
              ) : null}
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

      {bound && rail && boundFamily ? (
        <section>
          <h2>Stellar wallet</h2>
          {stellarBound ? (
            <dl>
              <dt>Paid on Stellar at</dt>
              <dd className="wrap">
                {addressLink(stellarBound)} <span className="muted">in {rail.asset.code}</span>
              </dd>
              {current?.creator.stellar_payout_verified_at ? (
                <>
                  <dt>Allowed in the wallet</dt>
                  <dd>
                    {rail.asset.code} confirmed {formatDateTime(current.creator.stellar_payout_verified_at)}
                  </dd>
                </>
              ) : null}
              {stellarPending ? (
                <>
                  <dt>Pending</dt>
                  <dd className="wrap" data-status="warn">
                    {addressLink(stellarPending)} — effective {formatDateTime(current?.creator.stellar_rebind_effective_at)}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="written measure">
              Agents paying on Stellar can&apos;t buy your listings yet. Add a Stellar wallet to accept {rail.asset.code}.
            </p>
          )}
          <details>
            <summary>
              <span className="label">{stellarBound ? "Change the Stellar wallet" : "Add a Stellar wallet"}</span>
              {stellarBound ? <span className="computed">{REBIND_DELAY_HOURS}h delay</span> : <span className="computed">live at once</span>}
            </summary>
            <p className="written measure">
              {stellarBound
                ? `A change takes ${REBIND_DELAY_HOURS} hours to land, and Stellar payouts keep going to the current wallet until then. The new wallet signs, then the wallet you are paid at now signs off, then you type the last six characters.`
                : "Connect a Stellar wallet and sign one message. It is live at once, and nothing already bound moves."}{" "}
              The new wallet must already allow {rail.asset.code}; if it does not, you will be told exactly what to add.
            </p>
            <StellarWallet
              mode="add"
              action="/dashboard/wallet/stellar"
              networkPassphrase={rail.passphrase}
              identity={bound}
              identityFamily={boundFamily}
              change={stellarBound !== null}
            />
          </details>
        </section>
      ) : null}
    </main>
  );
}

/**
 * JOURNEYS C2 step 3, BATTLE-TEST finding 18: the trustline is a manual step in Freighter,
 * and the page says exactly what to paste, from configuration, so testnet shows the
 * testnet asset. Server-rendered — the words and the issuer are in the HTML — and the
 * Refresh is a GET form, so it works with scripting off; `CopyButton` only adds the
 * shortcut after mount.
 */
function TrustlineSteps({
  address,
  asset,
  check,
}: {
  address: string;
  asset: { code: string; issuer: string };
  check: { ok: true } | { ok: false; reason: string | null; message: string } | null;
}) {
  if (check?.ok) {
    return (
      <section>
        <p role="status" data-status="pass" className="written measure">
          <span className="computed">{address}</span> now allows {asset.code}. Connect your Stellar wallet and sign below to finish binding it.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="trustline-heading">
      <h2 id="trustline-heading">Allow {asset.code} in your wallet</h2>
      <p role="alert" data-status="warn" className="written measure">
        Your wallet needs to allow {asset.code} before we can pay you. Add the asset in your wallet (in Freighter: <strong>Manage assets → Add manually</strong>), then paste: Asset code{" "}
        <strong>{asset.code}</strong>, Issuer <code className="wrap">{asset.issuer}</code>. Then come back and press Refresh.
      </p>
      <div className="copyline">
        <code>
          <span className="url">{asset.issuer}</span>
        </code>
        <CopyButton value={asset.issuer} what="The issuer" />
      </div>
      {check && !check.ok && check.reason !== "no_trustline" ? (
        <p role="alert" data-status="fail" className="written measure">
          {check.message}
        </p>
      ) : null}
      <form method="get" action="/dashboard/wallet">
        <input type="hidden" name="trustline" value={address} />
        <input type="hidden" name="refresh" value="1" />
        <p className="actions">
          <button type="submit">Refresh</button>
          <span className="muted wrap">
            Checking <span className="computed">{address}</span>
          </span>
        </p>
      </form>
    </section>
  );
}

async function checkTrustline(address: string): Promise<{ ok: true } | { ok: false; reason: string | null; message: string }> {
  try {
    await inspectStellarPayoutAccount(address);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: stellarBindReason(e), message: e instanceof ApiError ? e.message : "Horizon could not be reached. Try Refresh again in a moment." };
  }
}

function stellarExplorerUrl(network: string, address: string): string {
  return `https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/account/${encodeURIComponent(address)}`;
}

/**
 * The by-hand path: type an address, get a challenge, sign it elsewhere. For a hardware
 * wallet, an air-gapped signer, or a browser with no extension. Real, and works with
 * scripting off — and closed by default on first bind because almost nobody needs it.
 * Either family: an EVM `0x…` or a Stellar `G…`.
 */
function AddressForm({ bound }: { bound: string | null }) {
  // A change is to the EVM wallet only (the page offers it only when the bound address is
  // EVM); the Stellar wallet has its own section. The API refuses a cross-rail change too.
  return (
    <form method="post" action="/dashboard/wallet/challenge">
      <div className="field">
        <label htmlFor="address">{bound ? "New EVM address" : "Address"}</label>
        <input
          id="address"
          name={bound ? "new_address" : "address"}
          required
          pattern={bound ? "0x[0-9a-fA-F]{40}" : "(0x[0-9a-fA-F]{40}|G[A-Z2-7]{55})"}
          placeholder={bound ? "0x…" : "0x… or G…"}
          spellCheck={false}
          autoComplete="off"
        />
        <small>
          {bound
            ? "Where payouts on Base should go from now on. The next step asks the address bound now to sign off on the change."
            : "An EVM address paid on Base, or a Stellar account (G…) paid on Stellar, that you can sign from. The next step gives you a challenge to sign, which is how we know it is yours."}
        </small>
      </div>
      <p className="actions">
        <button type="submit">Get a challenge</button>
      </p>
    </form>
  );
}
