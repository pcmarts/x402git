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
