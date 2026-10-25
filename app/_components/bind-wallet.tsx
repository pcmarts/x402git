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

// --- Stellar wallet (Freighter) ------------------------------------------------------------
//
// 25 Oct 2026 (HACKMERIDIAN-JOURNEYS C2, C3, C5). The same discipline as `BindWallet`:
// nothing renders before mount, the wallet is reached at click time, and what reaches the
// server is the ordinary form — a `G…`, a nonce and a base64 SEP-53 signature, the three
// strings a person could have pasted. `@stellar/freighter-api` (v6) is imported on click,
// like the EVM helpers, so it never runs on the server; its functions answer with
// `{ …, error? }` rather than throwing, so every answer is checked before it is used.

type FreighterError = { message?: string; code?: number } | undefined;

function freighterMessage(error: FreighterError, fallback: string): string {
  return error && typeof error.message === "string" && error.message.length > 0 ? error.message : fallback;
}

const FREIGHTER_URL = "https://www.freighter.app/";

/** The words a person sees in Freighter's network menu, from the passphrase it reports. */
function networkLabel(passphrase: string, name?: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015") return "Mainnet";
  if (passphrase === "Test SDF Network ; September 2015") return "Testnet";
  return name && name.length > 0 ? name : "another network";
}

type Freighter = typeof import("@stellar/freighter-api");

/** Installed and unlocked, or an error sentence with the install link's job done by the caller. */
async function loadFreighter(): Promise<{ api: Freighter } | { missing: true }> {
  const api = await import("@stellar/freighter-api");
  const connected = await api.isConnected();
  if (connected.error || !connected.isConnected) return { missing: true };
  return { api };
}

/**
 * Freighter must be on the network this deployment pays on (`stellarRail().network`),
 * or the account it offers exists on the wrong ledger and the trustline check below
 * would read the wrong place. Said in the words of Freighter's own menu.
 */
async function requireNetwork(api: Freighter, expectedPassphrase: string): Promise<void> {
  const net = await api.getNetwork();
  if (net.error) throw new Error(freighterMessage(net.error, "Freighter did not say which network it is on."));
  if (net.networkPassphrase !== expectedPassphrase) {
    throw new Error(`Freighter is on ${networkLabel(net.networkPassphrase, net.network)}; switch it to ${networkLabel(expectedPassphrase)} in its network menu, then try again.`);
  }
}

async function freighterAddress(api: Freighter): Promise<string> {
  const access = await api.requestAccess();
  if (access.error) throw new Error(freighterMessage(access.error, "Freighter refused to share an account."));
  if (!access.address) throw new Error("Freighter did not share an account. Unlock it, allow this site, and try again.");
  return access.address;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** v4+ hands back base64; a v3 extension hands back a Buffer. The server wants base64 either way. */
async function freighterSign(api: Freighter, address: string, message: string, networkPassphrase: string): Promise<string> {
  const result = await api.signMessage(message, { networkPassphrase, address });
  if (result.error) throw new Error(freighterMessage(result.error, "Freighter refused to sign."));
  // Freighter says which key signed. A different account is refused here, in words, rather
  // than as a 401 from the server after the nonce is spent.
  if (result.signerAddress && result.signerAddress !== address) {
    throw new Error(`Freighter signed with ${result.signerAddress}, not ${address}. Switch to that account and try again.`);
  }
  const signed = result.signedMessage;
  if (typeof signed === "string" && signed.length > 0) return signed;
  if (signed && typeof signed === "object" && typeof (signed as { length?: unknown }).length === "number") return toBase64(Uint8Array.from(signed as unknown as ArrayLike<number>));
  throw new Error("Freighter did not return a signature. Try again, and approve the signing prompt.");
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
  /** Adding or changing beside an existing identity (C3, C5): Freighter proves the new G…, the wallet bound now signs off, type to confirm. */
  | { mode: "add"; action: string; networkPassphrase: string; identity: string; identityFamily: "evm" | "stellar"; change: boolean };

export function StellarWallet(props: StellarProps) {
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState<null | "freighter" | "step_up">(null);
  const [error, setError] = useState<string | null>(null);
  const [noFreighter, setNoFreighter] = useState(false);
  const [noEvmWallet, setNoEvmWallet] = useState(false);
  const [proved, setProved] = useState<string | null>(null);
  const [steppedUp, setSteppedUp] = useState(false);
  const [confirm, setConfirm] = useState("");
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
    setBusy("freighter");
    try {
      const loaded = await loadFreighter();
      if ("missing" in loaded) {
        setNoFreighter(true);
        return;
      }
      await requireNetwork(loaded.api, props.networkPassphrase);
      const address = await freighterAddress(loaded.api);
      const { nonce, message } = await fetchChallenge(address, "address_proof");
      const signature = await freighterSign(loaded.api, address, message, props.networkPassphrase);
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
      setProved(address);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [props, setField]);

  const stepUp = useCallback(async () => {
    if (props.mode !== "add" || !proved) return;
    setError(null);
    setBusy("step_up");
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
        const loaded = await loadFreighter();
        if ("missing" in loaded) {
          setNoFreighter(true);
          return;
        }
        await requireNetwork(loaded.api, props.networkPassphrase);
        signature = await freighterSign(loaded.api, props.identity, message, props.networkPassphrase);
      }
      if (!alive.current) return;
      setField("step_up_nonce", nonce);
      setField("step_up_signature", signature);
      setSteppedUp(true);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [props, proved, setField]);

  if (!mounted) return null;

  const installFreighter = noFreighter ? (
    <p className="written" role="status">
      Freighter is not in this browser, or is locked.{" "}
      <a href={FREIGHTER_URL} rel="noopener noreferrer" target="_blank">
        Install Freighter
      </a>
      , unlock it, then reload this page. Or bind by hand below.
    </p>
  ) : null;

  if (props.mode === "bind") {
    return (
      <div className="buy-state">
        <form method="post" action={props.action} ref={formRef}>
          <input type="hidden" name="address" />
          <input type="hidden" name="nonce" />
          <input type="hidden" name="signature" />
          <button type="button" data-variant="primary" onClick={connectAndProve} disabled={busy !== null}>
            {busy ? "Waiting for Freighter…" : "Connect Freighter and sign"}
          </button>
        </form>
        <p role="status" className="buy-status">
          {busy === null && !noFreighter ? "Freighter will ask you to connect, then to sign a short message. Nothing is sent on-chain and nothing costs XLM." : null}
        </p>
        {installFreighter}
        {error ? (
          <p role="alert" data-status="fail" className="written">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const confirmOk = confirm.trim().length === 6 || (proved !== null && confirm.trim().toUpperCase() === proved);
  const ready = proved !== null && steppedUp && confirmOk;
  const currentWalletLabel = props.identityFamily === "evm" ? "Sign with your current wallet" : "Sign with your current Stellar wallet (Freighter)";

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
            {busy === "freighter" ? "Waiting for Freighter…" : proved ? "Use a different Stellar wallet" : "1. Connect Freighter and sign"}
          </button>
          <button type="button" data-variant={proved && !steppedUp ? "primary" : undefined} onClick={stepUp} disabled={busy !== null || proved === null || steppedUp}>
            {busy === "step_up" ? "Waiting for your wallet…" : steppedUp ? "Signed off" : `2. ${currentWalletLabel}`}
          </button>
        </p>
        {proved ? (
          <p className="written wrap">
            Stellar wallet: <span className="computed">{proved}</span>
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="confirm_address">3. Type the last six characters of the Stellar address to confirm</label>
          <input
            id="confirm_address"
            name="confirm_address"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            maxLength={56}
            autoComplete="off"
            spellCheck={false}
            placeholder={proved ? proved.slice(-6) : "······"}
            disabled={proved === null}
          />
        </div>

        <p className="actions">
          <button type="submit" data-variant="primary" disabled={!ready}>
            {props.change ? `Queue the change (${REBIND_DELAY_HOURS_LABEL} delay)` : "Add the Stellar wallet"}
          </button>
        </p>
      </form>
      <p role="status" className="buy-status">
        {proved === null && !noFreighter
          ? "Freighter proves the new wallet; then the wallet you are paid at now signs off on the change. Nothing is sent on-chain."
          : null}
      </p>
      {installFreighter}
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
 * JOURNEYS C4, the mirror of `StellarWallet` in "add" mode: a Stellar-only creator adds an
 * EVM address. The EVM wallet proves the new `0x…`, Freighter signs off from the bound
 * `G…` with a challenge naming it, then type-to-confirm. Live at once, like C3.
 */
export function EvmWallet({ action, networkPassphrase, identity }: { action: string; networkPassphrase: string; identity: string }) {
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState<null | "evm" | "step_up">(null);
  const [error, setError] = useState<string | null>(null);
  const [noEvmWallet, setNoEvmWallet] = useState(false);
  const [noFreighter, setNoFreighter] = useState(false);
  const [proved, setProved] = useState<string | null>(null);
  const [steppedUp, setSteppedUp] = useState(false);
  const [confirm, setConfirm] = useState("");
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
    setBusy("evm");
    try {
      const { detectProvider } = await import("@/lib/web/wallet-checkout");
      const provider = detectProvider(window as unknown as { ethereum?: Eip1193Provider });
      if (!provider) {
        setNoEvmWallet(true);
        return;
      }
      const { connectAndSign } = await import("@/lib/web/wallet-bind");
      const signed = await connectAndSign(provider, { fetch: window.fetch.bind(window), baseUrl: "" });
      if (!alive.current) return;
      setField("evm_address", signed.address);
      setField("proof_nonce", signed.nonce);
      setField("proof_signature", signed.signature);
      // A different wallet after a sign-off: the sign-off named the old address, so it is spent.
      if (proved && proved.toLowerCase() !== signed.address.toLowerCase()) setSteppedUp(false);
      setProved(signed.address);
    } catch (e) {
      const { mapThrown } = await import("@/lib/web/wallet-checkout");
      if (alive.current) setError(mapThrown(e).message);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [proved, setField]);

  const stepUp = useCallback(async () => {
    if (!proved) return;
    setError(null);
    setBusy("step_up");
    try {
      // FR-5: the Stellar wallet bound now authorises the addition, and its challenge names
      // the incoming 0x… so the signature is good for this one change and nothing else.
      const { nonce, message } = await fetchChallenge(identity, "step_up", proved);
      const loaded = await loadFreighter();
      if ("missing" in loaded) {
        setNoFreighter(true);
        return;
      }
      await requireNetwork(loaded.api, networkPassphrase);
      const signature = await freighterSign(loaded.api, identity, message, networkPassphrase);
      if (!alive.current) return;
      setField("step_up_nonce", nonce);
      setField("step_up_signature", signature);
      setSteppedUp(true);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [identity, networkPassphrase, proved, setField]);

  if (!mounted) return null;

  const confirmOk = confirm.trim().length === 6 || (proved !== null && confirm.trim().toLowerCase() === proved.toLowerCase());
  const ready = proved !== null && steppedUp && confirmOk;

  return (
    <div className="buy-state">
      <form method="post" action={action} ref={formRef}>
        <input type="hidden" name="evm_address" />
        <input type="hidden" name="proof_nonce" />
        <input type="hidden" name="proof_signature" />
        <input type="hidden" name="step_up_nonce" />
        <input type="hidden" name="step_up_signature" />

        <p className="actions">
          <button type="button" data-variant={proved ? undefined : "primary"} onClick={connectAndProve} disabled={busy !== null}>
            {busy === "evm" ? "Waiting for your wallet…" : proved ? "Use a different EVM wallet" : "1. Connect EVM wallet and sign"}
          </button>
          <button type="button" data-variant={proved && !steppedUp ? "primary" : undefined} onClick={stepUp} disabled={busy !== null || proved === null || steppedUp}>
            {busy === "step_up" ? "Waiting for Freighter…" : steppedUp ? "Signed off" : "2. Sign with your Stellar wallet (Freighter)"}
          </button>
        </p>
        {proved ? (
          <p className="written wrap">
            EVM wallet: <span className="computed">{proved}</span>
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="confirm_evm_address">3. Type the last six characters of the EVM address to confirm</label>
          <input
            id="confirm_evm_address"
            name="confirm_address"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            maxLength={42}
            autoComplete="off"
            spellCheck={false}
            placeholder={proved ? proved.slice(-6) : "······"}
            disabled={proved === null}
          />
        </div>

        <p className="actions">
          <button type="submit" data-variant="primary" disabled={!ready}>
            Add the EVM wallet
          </button>
        </p>
      </form>
      <p role="status" className="buy-status">
        {proved === null && !noEvmWallet ? "Your EVM wallet proves the new address; then Freighter signs off from the wallet you are paid at now. Nothing is sent on-chain." : null}
      </p>
      {noEvmWallet ? (
        <p className="written" role="status">
          No EVM wallet in this browser.{" "}
          <a href="https://metamask.io/download/" rel="noopener noreferrer" target="_blank">
            Install MetaMask
          </a>{" "}
          or another wallet, then reload this page.
        </p>
      ) : null}
      {noFreighter ? (
        <p className="written" role="status">
          Freighter is not in this browser, or is locked. Unlock the Freighter holding <span className="computed">{identity}</span>, then try again.
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

/** FR-5 / §7.6, spelled for a button. Kept as a string so this client file imports nothing server-only. */
const REBIND_DELAY_HOURS_LABEL = "48h";
