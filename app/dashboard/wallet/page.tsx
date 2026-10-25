/**
 * GET /dashboard/wallet — bind or change the payout wallets (FR-1, FR-5, FR-26).
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
 * With JavaScript on and a browser wallet, it is one button (`BindWallet`, `StellarWallet`):
 * connect, fetch the challenge, sign, POST — the same three fields as the manual path,
 * which stays underneath for anyone binding a hardware or remote wallet by hand.
 *
 * Two wallets since 25 Oct 2026 (HACKMERIDIAN-JOURNEYS rule 1): one EVM address, paid on
 * every EVM rail this deployment runs (USDC on Base, USDT0 on Arbitrum), and one Stellar
 * account, paid in USDT0 on Stellar. A creator needs one, not both. The one Stellar-only
 * step is the trustline (C2 step 3): until the account has allowed the asset, Horizon says
 * so and this page prints the exact steps, with the issuer to copy, and a Refresh.
 *
 * Laid out by rail since 25 Oct 2026, 23:50 (founder: "show USDT0 Arb and USDC Base and
 * then USDT0 on Stellar, use the icons too, clean up the whole page, less text"). Two
 * sections, one per wallet, each a list of the rails it is paid on — the chip and the
 * address — and one closed disclosure holding its one action: add it (one signature,
 * live at once) or change it (the new wallet signs, the wallet bound now signs off, at
 * once unless the deployment runs a rebind delay; nothing typed). The rails come from
 * `payoutRailsFor`, the same function the 402 and the listing page read, so this page
 * can never name a rail a buyer would not be offered.
 */

import type { Metadata } from "next";
import { BindWallet, EvmWallet, StellarWallet } from "@/app/_components/bind-wallet";
import { CopyButton } from "@/app/_components/copy-button";
import { Notice } from "@/app/_components/notice";
import { RailChip } from "@/app/_components/rail-marks";
import { shortAddress } from "@/app/dashboard/[id]/where-you-get-paid";
import { currentStellarPayoutAddress, inspectStellarPayoutAccount, stellarBindReason } from "@/lib/auth/stellar-binding";
import { type PayoutRail, payoutRailsFor } from "@/lib/core/access";
import { type StellarRail, paymentChain, stellarRail } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { currentCreator, currentSession, signInPath } from "@/lib/web/current";
import { challengeByNonce } from "@/lib/web/loaders";
import { formatDateTime } from "@/lib/web/manifest-view";
import { explorerAddressUrl } from "@/lib/web/wallet-checkout";
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
  const boundFamily = bound ? addressFamily(bound) : null;
  const evmBound = boundFamily === "evm" ? bound : null;
  const pending = current?.creator.pending_payout_address ?? null;

  // `stellarRail()` throws on a misconfigured deployment; this page is not the place to
  // surface that, so a broken rail reads as "not offered here" and the EVM half still works.
  let rail: StellarRail | null = null;
  try {
    rail = stellarRail();
  } catch {
    rail = null;
  }
  const stellarBound = current ? currentStellarPayoutAddress(current.creator) : null;
  const stellarPending = current?.creator.pending_stellar_payout_address ?? null;

  // The rails this deployment pays on, each with where it pays this creator (null before a bind).
  const rails = payoutRailsFor(current?.creator ?? { payout_address: "", stellar_payout_address: null });
  const evmRails = rails.filter((r) => r.family === "evm");
  const stellarRails = rails.filter((r) => r.family === "stellar");

  // The Refresh on the trustline steps (C2 step 3): read Horizon again for that account.
  const trustlineCheck = rail && trustline && refresh === "1" ? await checkTrustline(trustline) : null;

  const chain = paymentChain();
  const addressLink = (value: string) => {
    const family = addressFamily(value);
    const url = family === "stellar" && rail ? stellarExplorerUrl(rail.network, value) : family === "evm" ? explorerAddressUrl(chain.chainId, value) : null;
    return url ? (
      <a href={url} rel="noopener noreferrer" target="_blank" className="computed" title={value}>
        {shortAddress(value)}
      </a>
    ) : (
      <span className="computed" title={value}>
        {shortAddress(value)}
      </span>
    );
  };

  /** One line per rail: the chip, then where it pays, or that it does not yet. */
  const railLines = (list: PayoutRail[], at: string | null) => (
    <ul className="facts">
      {list.map((r) => (
        <li key={r.network} data-network={r.network}>
          <RailChip network={r.network} symbol={r.symbol} /> {at ? addressLink(at) : <span className="muted">not yet</span>}
        </li>
      ))}
    </ul>
  );

  return (
    <main>
      <h1>Wallet</h1>
      <Notice ok={ok} error={error} />

      {rail && trustline ? <TrustlineSteps address={trustline} asset={rail.asset} check={trustlineCheck} /> : null}

      {challenge && address ? (
        <section>
          <h2>Sign this</h2>
          <p className="written measure">
            Sign these exact bytes with the wallet holding <span className="computed">{address}</span>, then paste the signature below. Single use;
            expires <span className="computed">{formatDateTime(challenge.expires_at)}</span>.
          </p>
          {queued ? (
            <p className="written measure">
              You are signing from the wallet bound now, to move payouts to <span className="computed">{queued}</span>. An API key alone cannot do this.
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
                  ? "SEP-53, base64 (your wallet's signMessage, or the x402git-stellar CLI)."
                  : "EIP-191 personal_sign, from that address."}
              </small>
            </div>
            {addressFamily(address) === "evm" ? <BindWallet mode="sign" address={address} message={challenge.message} signatureFieldId="signature" /> : null}
            <p className="actions">
              <button type="submit">{bound ? "Change the address" : "Bind this address"}</button>
              <a href="/dashboard/wallet">Start over</a>
            </p>
          </form>
        </section>
      ) : bound ? (
        <>
          <p className="written measure">
            Each sale pays out on the rail it was bought on. The ledger is on <a href="/dashboard/earnings">Earnings</a>.
          </p>

          <section aria-labelledby="evm-wallet">
            <h2 id="evm-wallet">EVM wallet</h2>
            {railLines(evmRails, evmBound)}
            {pending ? (
              <p className="written" data-status="warn">
                <small>
                  Moving to {addressLink(pending)} on {formatDateTime(current?.creator.rebind_effective_at)}
                </small>
              </p>
            ) : null}
            {evmBound ? (
              <details>
                <summary>
                  <span className="label">Change the EVM wallet</span>
                </summary>
                <p className="written measure">
                  <small className="muted">Pick the new account in your wallet and sign; then the account you are paid at now signs off.</small>
                </p>
                <EvmWallet action="/dashboard/wallet/evm" change={{ identity: evmBound }} />
                <details>
                  <summary>
                    <span className="label">Change by hand</span>
                  </summary>
                  <AddressForm bound={evmBound} />
                </details>
              </details>
            ) : !pending ? (
              <details>
                <summary>
                  <span className="label">Add an EVM wallet</span>
                  <span className="computed">live at once</span>
                </summary>
                <p className="written measure">
                  <small className="muted">MetaMask, Coinbase Wallet… Connect and sign once.</small>
                </p>
                <EvmWallet action="/dashboard/wallet/evm" />
              </details>
            ) : null}
          </section>

          {rail && boundFamily ? (
            <section aria-labelledby="stellar-wallet">
              <h2 id="stellar-wallet">Stellar wallet</h2>
              {railLines(stellarRails, stellarBound)}
              {stellarBound && current?.creator.stellar_payout_verified_at ? (
                <p className="written">
                  <small className="muted">
                    {rail.asset.code} allowed · checked {formatDateTime(current.creator.stellar_payout_verified_at)}
                  </small>
                </p>
              ) : null}
              {stellarPending ? (
                <p className="written" data-status="warn">
                  <small>
                    Moving to {addressLink(stellarPending)} on {formatDateTime(current?.creator.stellar_rebind_effective_at)}
                  </small>
                </p>
              ) : null}
              <details>
                <summary>
                  <span className="label">{stellarBound ? "Change the Stellar wallet" : "Add a Stellar wallet"}</span>
                  {stellarBound ? null : <span className="computed">live at once</span>}
                </summary>
                <p className="written measure">
                  <small className="muted">
                    {stellarBound
                      ? "Connect the new wallet and sign; then the wallet you are paid at now signs off."
                      : "Freighter, Hana, HOT, xBull, Lobstr… Connect and sign once."}{" "}
                    The wallet must allow {rail.asset.code}; if it does not, you will be told what to add.
                  </small>
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
        </>
      ) : (
        <>
          <p className="written measure">
            Connect the wallet you want to be paid at and sign one message. It has to be a wallet you can sign from, not an exchange deposit
            address.
          </p>

          <section aria-labelledby="evm-wallet">
            <h2 id="evm-wallet">EVM wallet</h2>
            {railLines(evmRails, null)}
            <BindWallet mode="bind" action="/dashboard/wallet/bind" />
          </section>

          {rail ? (
            <section aria-labelledby="stellar-wallet">
              <h2 id="stellar-wallet">Stellar wallet</h2>
              {railLines(stellarRails, null)}
              <p className="written measure">
                <small className="muted">The wallet must allow {rail.asset.code}; if it does not yet, the next step tells you what to add.</small>
              </p>
              <StellarWallet mode="bind" action="/dashboard/wallet/bind" networkPassphrase={rail.passphrase} />
            </section>
          ) : null}

          <details>
            <summary>
              <span className="label">No browser wallet? Bind by hand</span>
            </summary>
            <AddressForm bound={null} />
          </details>
        </>
      )}
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
            ? "Where EVM payouts go from now on. The next step asks the wallet bound now to sign off."
            : "An EVM address (0x…) or a Stellar account (G…) you can sign from. The next step is a challenge to sign."}
        </small>
      </div>
      <p className="actions">
        <button type="submit">Get a challenge</button>
      </p>
    </form>
  );
}
