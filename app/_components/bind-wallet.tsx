"use client";

/**
 * app/_components/bind-wallet.tsx — one button that binds a payout address (FR-1), or
 * signs a change-of-address challenge (FR-5), from the browser wallet.
 *
 * Same discipline as buy-with-wallet.tsx: before hydration it renders nothing that
 * cannot work; the provider is looked up at click time because extensions inject late
 * (the previous inline script checked `window.ethereum` at parse time and so never saw
 * MetaMask); and when it has what it needs it POSTs the ordinary form — the server sees
 * the same three fields a person with no wallet would have pasted.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Eip1193Provider } from "@/lib/web/wallet-checkout";

type Props =
  | { mode: "bind"; action: string }
  | { mode: "sign"; address: string; message: string; signatureFieldId: string };

type Phase = "idle" | "busy" | "signed" | "error";

export function BindWallet(props: Props) {
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    alive.current = true;
    setMounted(true);
    return () => {
      alive.current = false;
    };
  }, []);

  const provider = useCallback(async (): Promise<Eip1193Provider | null> => {
    const { detectProvider } = await import("@/lib/web/wallet-checkout");
    return detectProvider(window as unknown as { ethereum?: Eip1193Provider });
  }, []);

  const run = useCallback(async () => {
    setError(null);
    setPhase("busy");
    try {
      const p = await provider();
      if (!p) {
        setNoWallet(true);
        setPhase("idle");
        return;
      }
      if (props.mode === "bind") {
        const { connectAndSign } = await import("@/lib/web/wallet-bind");
        const signed = await connectAndSign(p, { fetch: window.fetch.bind(window), baseUrl: "" });
        if (!alive.current) return;
        const form = formRef.current;
        if (!form) return;
        (form.elements.namedItem("address") as HTMLInputElement).value = signed.address;
        (form.elements.namedItem("nonce") as HTMLInputElement).value = signed.nonce;
        (form.elements.namedItem("signature") as HTMLInputElement).value = signed.signature;
        setPhase("signed");
        form.submit();
      } else {
        const { signAs } = await import("@/lib/web/wallet-bind");
        const signature = await signAs(p, props.address, props.message);
        if (!alive.current) return;
        const box = document.getElementById(props.signatureFieldId) as HTMLTextAreaElement | null;
        if (box) box.value = signature;
        setPhase("signed");
      }
    } catch (e) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      if (!alive.current) return;
      setError(mapThrown(e).message);
      setPhase("error");
    }
  }, [props, provider]);

  if (!mounted) return null;

  if (noWallet) {
    return (
      <div className="buy-state" role="status">
        <p className="written">No wallet in this browser. Install one and reload, or bind by hand below.</p>
        <p className="written">
          <a href="https://metamask.io/download/" rel="noopener noreferrer" target="_blank">
            MetaMask
          </a>{" "}
          ·{" "}
          <a href="https://www.coinbase.com/wallet/downloads" rel="noopener noreferrer" target="_blank">
            Coinbase Wallet
          </a>
        </p>
      </div>
    );
  }

  const busy = phase === "busy";
  const label =
    props.mode === "bind"
      ? busy
        ? "Waiting for your wallet…"
        : phase === "signed"
          ? "Binding…"
          : "Connect wallet and sign"
      : busy
        ? "Waiting for your wallet…"
        : phase === "signed"
          ? "Signed — now submit"
          : "Sign with wallet";

  return (
    <div className="buy-state">
      {props.mode === "bind" ? (
        <form method="post" action={props.action} ref={formRef}>
          <input type="hidden" name="address" />
          <input type="hidden" name="nonce" />
          <input type="hidden" name="signature" />
          <button type="button" data-variant="primary" onClick={run} disabled={busy || phase === "signed"}>
            {label}
          </button>
        </form>
      ) : (
        <button type="button" onClick={run} disabled={busy}>
          {label}
        </button>
      )}
      <p role="status" className="buy-status">
        {props.mode === "bind" && phase === "idle"
          ? "Your wallet will ask you to connect, then to sign a short message. Nothing is sent on-chain and nothing costs gas."
          : null}
      </p>
      {error ? (
        <p role="alert" data-status="fail" className="written">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- Stellar wallet (any wallet the Stellar Wallets Kit knows) ----------------------------
//
// 25 Oct 2026 (HACKMERIDIAN-JOURNEYS C2, C3, C5). The same discipline as `BindWallet`:
// nothing renders before mount, the wallet is reached at click time, and what reaches the
// server is the ordinary form — a `G…`, a nonce and a base64 SEP-53 signature, the three
// strings a person could have pasted.
//
// Later that evening (founder: "right now we only 'support' freighter when i'd like to
// have all stellar wallets supported"): the press opens the Stellar Wallets Kit's picker,
// the same kit the listing page pays through (lib/web/stellar-checkout.ts), so Freighter,
// Hana, HOT, xBull, Lobstr and the rest can bind. Binding needs a SEP-43 `signMessage`,
// not an auth entry, so the picker here is filtered on that (`loadKit(…, "sign")`):
// Albedo, Rabet, Ledger and Trezor refuse it in their own code and are left out. The kit
// is imported on the press, like the EVM helpers, so it never runs on the server; a wallet
// that is not installed is the kit's modal's business (it links to the install page), so
// this file no longer has an install panel of its own.
//
// Adding is one button (25 Oct 2026, ~21:30, HackMeridian; the founder: "lets not have
// the confirm the last 6 digits of your evm wallet - a lot of hassle. Do we need to have
// the stellar wallet confirm? Feels needless."). Adding a wallet for a rail the account
// has no address on yet (C3 here, C4 in `EvmWallet`) is: connect the new wallet, sign
// once, and the form posts. The proof shows control of the destination, the page is a
// signed-in GitHub session, and nothing already flowing moves; PATCH /api/creators/me's
// header has the accepted risk. Changing an address (C5) is two steps: the new wallet
// proves itself and the wallet bound now signs off. The typed characters and the 48-hour
// wait went at 23:30 the same evening (founder: "drop that requirement"; "make it instant").
// A change lands when the form posts unless the deployment runs a rebind delay.

type KitModule = typeof import("@/lib/web/stellar-checkout");
type Kit = Awaited<ReturnType<KitModule["loadKit"]>>;

/** The wallets the picker offers for signing, named where a refusal needs an alternative. */
const SIGNING_WALLETS = "Freighter, Hana, HOT Wallet, xBull or Lobstr";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : typeof error === "string" ? error : "";
}

/**
 * The picker, then the chosen wallet's account, then the network check: the wallet must be
 * on the network this deployment pays on (`stellarRail().network`), or the account it
 * offers exists on the wrong ledger and the trustline check would read the wrong place.
 */
async function openStellarWallet(mod: KitModule, passphrase: string): Promise<{ kit: Kit; address: string; walletName: string }> {
  const kit = await mod.loadKit(passphrase, "sign");
  const { address } = await kit.authModal();
  const walletName = kit.selectedModule.productName;
  await mod.requireNetwork(kit, passphrase, walletName);
  return { kit, address, walletName };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** SEP-43 `signMessage` through the kit. The server wants base64; a stray byte array is encoded. */
async function signWithWallet(kit: Kit, walletName: string, address: string, message: string, networkPassphrase: string): Promise<string> {
  let result: { signedMessage: unknown; signerAddress?: string };
  try {
    result = await kit.signMessage(message, { networkPassphrase, address });
  } catch (error) {
    if (/\b(?:does|do) not support the "?signMessage"? (?:function|method)/i.test(messageOf(error))) {
      throw new Error(`${walletName} can't sign a message yet. Use ${SIGNING_WALLETS}, or bind by hand below.`);
    }
    throw error;
  }
  // The wallet says which key signed. A different account is refused here, in words, rather
  // than as a 401 from the server after the nonce is spent.
  if (result.signerAddress && result.signerAddress !== address) {
    throw new Error(`${walletName} signed with ${result.signerAddress}, not ${address}. Switch to that account and try again.`);
  }
  const signed = result.signedMessage;
  if (typeof signed === "string" && signed.length > 0) return signed;
  if (signed && typeof signed === "object" && typeof (signed as { length?: unknown }).length === "number") return toBase64(Uint8Array.from(signed as unknown as ArrayLike<number>));
  throw new Error(`${walletName} did not return a signature. Try again, and approve the signing prompt.`);
}

async function fetchChallenge(address: string, purpose: string, newPayoutAddress?: string): Promise<{ nonce: string; message: string }> {
  const params = new URLSearchParams({ address, purpose });
  if (newPayoutAddress) params.set("new_payout_address", newPayoutAddress);
  const res = await fetch(`/api/auth/challenge?${params.toString()}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The challenge could not be issued (HTTP ${res.status}).`);
  }
  return (await res.json()) as { nonce: string; message: string };
}

type StellarProps =
  /** First bind, no account yet (C2): one button, then POST to the bind route. */
  | { mode: "bind"; action: string; networkPassphrase: string }
  /**
   * Beside an existing identity. Adding (C3, `change: false`): one button, the new wallet's
   * proof alone, then POST. Changing (C5, `change: true`): the new wallet proves the G…, the
   * wallet bound now signs off.
   */
  | { mode: "add"; action: string; networkPassphrase: string; identity: string; identityFamily: "evm" | "stellar"; change: boolean };

export function StellarWallet(props: StellarProps) {
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState<null | "wallet" | "step_up">(null);
  const [error, setError] = useState<string | null>(null);
  /** The picked wallet's name, for "Waiting for Hana…" and the trustline words. */
  const [walletName, setWalletName] = useState<string | null>(null);
  const [noEvmWallet, setNoEvmWallet] = useState(false);
  const [proved, setProved] = useState<string | null>(null);
  const [steppedUp, setSteppedUp] = useState(false);
  /** An addition's form has been posted: the button stays down while the page navigates. */
  const [sent, setSent] = useState(false);
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    alive.current = true;
    setMounted(true);
    return () => {
      alive.current = false;
    };
  }, []);

  const setField = useCallback((name: string, value: string) => {
    const el = formRef.current?.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.value = value;
  }, []);

  const connectAndProve = useCallback(async () => {
    setError(null);
    setBusy("wallet");
    let mod: KitModule | null = null;
    try {
      mod = await import("@/lib/web/stellar-checkout");
      const { kit, address, walletName: name } = await openStellarWallet(mod, props.networkPassphrase);
      setWalletName(name);
      const { nonce, message } = await fetchChallenge(address, "address_proof");
      const signature = await signWithWallet(kit, name, address, message, props.networkPassphrase);
      if (!alive.current) return;
      if (props.mode === "bind") {
        setField("address", address);
        setField("nonce", nonce);
        setField("signature", signature);
        formRef.current?.submit();
        return;
      }
      setField("stellar_address", address);
      setField("proof_nonce", nonce);
      setField("proof_signature", signature);
      if (!props.change) {
        // Adding: the proof is the whole of it.
        setSent(true);
        formRef.current?.submit();
        return;
      }
      // A different wallet after a sign-off: the sign-off named the old address, so it is spent.
      if (proved && proved !== address) setSteppedUp(false);
      setProved(address);
    } catch (e) {
      // The picker's ✕: a change of mind, not an error.
      if (mod?.isPickerClosed(e)) return;
      if (alive.current) setError(messageOf(e) || String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [props, proved, setField]);

  const stepUp = useCallback(async () => {
    if (props.mode !== "add" || !props.change || !proved) return;
    setError(null);
    setBusy("step_up");
    let mod: KitModule | null = null;
    try {
      // FR-5: the wallet bound *now* authorises the change, and its challenge names the
      // incoming G… so the signature is good for this one change and nothing else.
      const { nonce, message } = await fetchChallenge(props.identity, "step_up", proved);
      let signature: string;
      if (props.identityFamily === "evm") {
        const { detectProvider } = await import("@/lib/web/wallet-checkout");
        const provider = detectProvider(window as unknown as { ethereum?: Eip1193Provider });
        if (!provider) {
          setNoEvmWallet(true);
          return;
        }
        const { signAs } = await import("@/lib/web/wallet-bind");
        signature = await signAs(provider, props.identity, message);
      } else {
        mod = await import("@/lib/web/stellar-checkout");
        const { kit, address, walletName: name } = await openStellarWallet(mod, props.networkPassphrase);
        if (address !== props.identity) {
          throw new Error(`${name} offered ${address}, not the wallet you are paid at (${props.identity}). Switch to that account and try again.`);
        }
        signature = await signWithWallet(kit, name, props.identity, message, props.networkPassphrase);
      }
      if (!alive.current) return;
      setField("step_up_nonce", nonce);
      setField("step_up_signature", signature);
      setSteppedUp(true);
    } catch (e) {
      if (mod?.isPickerClosed(e)) return;
      if (alive.current) setError(messageOf(e) || String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [props, proved, setField]);

  if (!mounted) return null;

  const waiting = `Waiting for ${walletName ?? "your wallet"}…`;
  const pickLine = "Pick a wallet (Freighter, Hana, HOT, xBull, Lobstr…), connect, then sign a short message. Nothing is sent on-chain and nothing costs XLM.";

  if (props.mode === "bind") {
    return (
      <div className="buy-state">
        <form method="post" action={props.action} ref={formRef}>
          <input type="hidden" name="address" />
          <input type="hidden" name="nonce" />
          <input type="hidden" name="signature" />
          <button type="button" data-variant="primary" onClick={connectAndProve} disabled={busy !== null}>
            {busy ? waiting : "Connect a Stellar wallet and sign"}
          </button>
        </form>
        <p role="status" className="buy-status">
          {busy === null ? pickLine : null}
        </p>
        {error ? (
          <p role="alert" data-status="fail" className="written">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (!props.change) {
    return (
      <div className="buy-state">
        <form method="post" action={props.action} ref={formRef}>
          <input type="hidden" name="stellar_address" />
          <input type="hidden" name="proof_nonce" />
          <input type="hidden" name="proof_signature" />
          <button type="button" data-variant="primary" onClick={connectAndProve} disabled={busy !== null || sent}>
            {busy ? waiting : sent ? "Adding…" : "Connect a Stellar wallet and sign"}
          </button>
        </form>
        <p role="status" className="buy-status">
          {busy === null && !sent ? pickLine : null}
        </p>
        {error ? (
          <p role="alert" data-status="fail" className="written">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const ready = proved !== null && steppedUp;
  const currentWalletLabel = props.identityFamily === "evm" ? "Sign with your current wallet" : "Sign with your current Stellar wallet";

  return (
    <div className="buy-state">
      <form method="post" action={props.action} ref={formRef}>
        <input type="hidden" name="stellar_address" />
        <input type="hidden" name="proof_nonce" />
        <input type="hidden" name="proof_signature" />
        <input type="hidden" name="step_up_nonce" />
        <input type="hidden" name="step_up_signature" />

        <p className="actions">
          <button type="button" data-variant={proved ? undefined : "primary"} onClick={connectAndProve} disabled={busy !== null}>
            {busy === "wallet" ? waiting : proved ? "Use a different Stellar wallet" : "1. Connect the new Stellar wallet and sign"}
          </button>
          <button type="button" data-variant={proved && !steppedUp ? "primary" : undefined} onClick={stepUp} disabled={busy !== null || proved === null || steppedUp}>
            {busy === "step_up" ? "Waiting for your wallet…" : steppedUp ? "Signed off" : `2. ${currentWalletLabel}`}
          </button>
        </p>
        {proved ? (
          <p className="written wrap">
            New Stellar wallet: <span className="computed">{proved}</span>
          </p>
        ) : null}

        <p className="actions">
          <button type="submit" data-variant="primary" disabled={!ready}>
            Change the Stellar wallet
          </button>
        </p>
      </form>
      <p role="status" className="buy-status">
        {proved === null ? "The new wallet proves itself (Freighter, Hana, HOT, xBull, Lobstr…); then the wallet you are paid at now signs off on the change. Nothing is sent on-chain." : null}
      </p>
      {noEvmWallet ? (
        <p className="written" role="status">
          No EVM wallet in this browser to sign with. Open this page in the browser that holds <span className="computed">{props.identity}</span>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-status="fail" className="written">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * JOURNEYS C4 and C5 for the EVM wallet. Adding (no `change`): one button — the EVM wallet
 * connects and signs an `address_proof` for the new `0x…`, and the form posts. Live at once.
 *
 * Changing (`change: { identity }`; 25 Oct 2026, 23:30, the founder: "allow me to just
 * choose a new wallet by pressing a button - i don't like this whole manually challenge
 * ux"): two buttons in place of the by-hand form. 1. the wallet's account picker opens
 * (`pickAccount`) and the new account signs an `address_proof`; 2. the account bound now
 * signs the step-up that names the new one. Nothing to type, and no wait: the change
 * lands when the form posts, unless the deployment runs a rebind delay. The by-hand form
 * stays under a disclosure on the page for hardware and remote wallets.
 */
export function EvmWallet({ action, change }: { action: string; change?: { identity: string } }) {
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState<null | "new" | "step_up">(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noEvmWallet, setNoEvmWallet] = useState(false);
  const [proved, setProved] = useState<string | null>(null);
  const [steppedUp, setSteppedUp] = useState(false);
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    alive.current = true;
    setMounted(true);
    return () => {
      alive.current = false;
    };
  }, []);

  const setField = useCallback((name: string, value: string) => {
    const el = formRef.current?.elements.namedItem(name) as HTMLInputElement | null;
    if (el) el.value = value;
  }, []);

  const provider = useCallback(async (): Promise<Eip1193Provider | null> => {
    const { detectProvider } = await import("@/lib/web/wallet-checkout");
    return detectProvider(window as unknown as { ethereum?: Eip1193Provider });
  }, []);

  const connectAndProve = useCallback(async () => {
    setError(null);
    setBusy("new");
    try {
      const p = await provider();
      if (!p) {
        setNoEvmWallet(true);
        return;
      }
      const bind = await import("@/lib/web/wallet-bind");
      // A change opens the account picker, so "a different wallet" is one press rather than
      // a trip into the extension's menu; an addition takes whatever account is connected.
      const address = change ? await bind.pickAccount(p) : await bind.connectedAddress(p);
      if (change && address.toLowerCase() === change.identity.toLowerCase()) {
        throw new Error(`${address} is the wallet you are paid at now. Pick a different account in your wallet, then try again.`);
      }
      const signed = await bind.proveAddress(p, address, { fetch: window.fetch.bind(window), baseUrl: "" });
      if (!alive.current) return;
      setField("evm_address", signed.address);
      setField("proof_nonce", signed.nonce);
      setField("proof_signature", signed.signature);
      if (!change) {
        setSent(true);
        formRef.current?.submit();
        return;
      }
      // A different wallet after a sign-off: the sign-off named the old address, so it is spent.
      if (proved && proved !== signed.address) setSteppedUp(false);
      setProved(signed.address);
    } catch (e) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      if (alive.current) setError(mapThrown(e).message);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [change, proved, provider, setField]);

  const stepUp = useCallback(async () => {
    if (!change || !proved) return;
    setError(null);
    setBusy("step_up");
    try {
      const p = await provider();
      if (!p) {
        setNoEvmWallet(true);
        return;
      }
      // FR-5: the account bound *now* authorises the change, and its challenge names the
      // incoming address so the signature is good for this one change and nothing else.
      const { nonce, message } = await fetchChallenge(change.identity, "step_up", proved);
      const { pickAccount, signAs } = await import("@/lib/web/wallet-bind");
      // The picker again, so the account bound now can be chosen without leaving the page.
      await pickAccount(p);
      const signature = await signAs(p, change.identity, message);
      if (!alive.current) return;
      setField("step_up_nonce", nonce);
      setField("step_up_signature", signature);
      setSteppedUp(true);
    } catch (e) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      if (alive.current) setError(mapThrown(e).message);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [change, proved, provider, setField]);

  if (!mounted) return null;

  const install = noEvmWallet ? (
    <p className="written" role="status">
      No EVM wallet in this browser.{" "}
      <a href="https://metamask.io/download/" rel="noopener noreferrer" target="_blank">
        Install MetaMask
      </a>{" "}
      or another wallet, then reload this page.
    </p>
  ) : null;
  const errorLine = error ? (
    <p role="alert" data-status="fail" className="written">
      {error}
    </p>
  ) : null;

  if (!change) {
    return (
      <div className="buy-state">
        <form method="post" action={action} ref={formRef}>
          <input type="hidden" name="evm_address" />
          <input type="hidden" name="proof_nonce" />
          <input type="hidden" name="proof_signature" />
          <button type="button" data-variant="primary" onClick={connectAndProve} disabled={busy !== null || sent}>
            {busy ? "Waiting for your wallet…" : sent ? "Adding…" : "Connect MetaMask and sign"}
          </button>
        </form>
        <p role="status" className="buy-status">
          {busy === null && !sent && !noEvmWallet ? "Your wallet will ask you to connect, then to sign a short message. Nothing is sent on-chain and nothing costs gas." : null}
        </p>
        {install}
        {errorLine}
      </div>
    );
  }

  const ready = proved !== null && steppedUp;
  return (
    <div className="buy-state">
      <form method="post" action={action} ref={formRef} onSubmit={() => setSent(true)}>
        <input type="hidden" name="evm_address" />
        <input type="hidden" name="proof_nonce" />
        <input type="hidden" name="proof_signature" />
        <input type="hidden" name="step_up_nonce" />
        <input type="hidden" name="step_up_signature" />

        <p className="actions">
          <button type="button" data-variant={proved ? undefined : "primary"} onClick={connectAndProve} disabled={busy !== null || sent}>
            {busy === "new" ? "Waiting for your wallet…" : proved ? "Use a different wallet" : "1. Pick the new wallet and sign"}
          </button>
          <button type="button" data-variant={proved && !steppedUp ? "primary" : undefined} onClick={stepUp} disabled={busy !== null || proved === null || steppedUp || sent}>
            {busy === "step_up" ? "Waiting for your wallet…" : steppedUp ? "Signed off" : "2. Sign with your current wallet"}
          </button>
        </p>
        {proved ? (
          <p className="written wrap">
            New EVM wallet: <span className="computed">{proved}</span>
          </p>
        ) : null}

        <p className="actions">
          <button type="submit" data-variant="primary" disabled={!ready || sent}>
            {sent ? "Changing…" : "Change the EVM wallet"}
          </button>
        </p>
      </form>
      <p role="status" className="buy-status">
        {proved === null && !noEvmWallet
          ? "Your wallet's account picker opens: choose the new account and sign. Then the account you are paid at now signs off. Nothing is sent on-chain and nothing costs gas."
          : null}
      </p>
      {install}
      {errorLine}
    </div>
  );
}
