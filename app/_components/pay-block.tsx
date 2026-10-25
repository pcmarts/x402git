"use client";

/**
 * app/_components/pay-block.tsx — how to pay, as one choice (25 Oct 2026, HackMeridian).
 *
 * A creator paid on Base, Arbitrum and Stellar used to get two buttons stacked in the box,
 * Base's and Freighter's, and nothing for Arbitrum. The founder: "really easy and clear".
 * The shape is JOURNEYS B0's — one row per way the listing can be paid, the token and the
 * chain as a chip with their marks, the wallet this browser has beside it, and the chosen
 * row carrying the one primary button:
 *
 *   ◉ USDT0 on Arbitrum    MetaMask detected
 *     [ Buy — $9 with MetaMask ]
 *   ○ USDC on Base         MetaMask detected
 *   ○ USDT0 on Stellar     Stellar wallets: Freighter, Hana, HOT…
 *
 * Three rules hold it together.
 *
 * - **Only what the 402 offers.** The rows are `paymentOptionsFor`'s, the function the 402's
 *   `accepts` is built from, so a row is never a rail the paywall would refuse. The buyer
 *   sees the price in their token and nothing about where the creator is paid.
 * - **The choice is made for them, and stays theirs.** The row last used in this browser
 *   (localStorage, best effort), else the first row whose wallet is installed, else the
 *   first row. Freighter answers its "installed?" late, so the pick can still move until
 *   the buyer touches the block; from the first touch it is fixed, and a press never lands
 *   on a button that is about to be swapped out.
 * - **One row, one button.** The selected row renders the existing button for its rail —
 *   `BuyWithWallet` for an EVM row, told its chain and token; `BuyWithStellar` (was `BuyWithFreighter`) for the
 *   Stellar row — so the money paths are the ones already proved. One option is the chip
 *   and its button, no radios.
 *
 * Detection asks two questions on load and nothing more: is there a `window.ethereum`
 * (and whose), and is Freighter installed (`isConnected`, no prompt, no account). Access
 * is still asked for on the press. The server render — what `curl` and a reader without
 * script get — is the rows as static chips and the chosen row's own one-line fallback.
 *
 * Amended 25 Oct 2026, ~21:30 (founder: "Lets use the stellar wallet SDK instead so we can
 * support more wallets?"). The Stellar row pays through the Stellar Wallets Kit's picker
 * (`BuyWithStellar`), so it is no longer one wallet's row: before connect its line names the
 * family ("Stellar wallets: Freighter, Hana, HOT…"), after it the wallet chosen. Detection
 * on load is now the EVM question alone — Freighter's `isConnected()` is no longer asked,
 * because which Stellar wallets are installed is the picker's to find out, on the press.
 * So the preselect cannot wait on a Stellar answer either: the row last used here, else
 * the first EVM row when an EVM wallet is injected, else the Stellar row (its picker
 * covers a browser with no wallet, with install links), else the first row.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { chainLabel } from "@/lib/buy-links";
import type { PaymentOption } from "@/lib/core/access";
import { detectProvider, type ProviderRoot, walletName } from "@/lib/web/checkout-copy";
import type { StellarCheckoutConfig } from "@/lib/web/stellar-checkout";
import { BuyWithStellar } from "./buy-with-stellar";
import { BuyWithWallet } from "./buy-with-wallet";
import { RailChip } from "./rail-marks";

/** One EVM rail as a page may know it: plain data, computed on the server from `evmChains()`. */
export type EvmChain = {
  network: string;
  chainId: number;
  /** "Arbitrum", "Base Sepolia". */
  chainName: string;
  /** Explorer base, no trailing slash; "" when none is known. */
  explorer: string;
  symbol: string;
};

export type PayRow =
  | { kind: "evm"; network: string; symbol: string; chain: EvmChain }
  | { kind: "stellar"; network: string; symbol: string; chainName: string; config: StellarCheckoutConfig };

/** What the block has learned about this browser's wallets; `undefined` is "not asked yet". */
export type Detected = { evm: string | null | undefined };

type Props = {
  /** `paymentOptionsFor(creator, listing)`, in its order (EVM first, the primary rail first of all). */
  options: Pick<PaymentOption, "network" | "asset_symbol">[];
  /** Chain facts for each EVM option, by `network`. */
  chains: EvmChain[];
  /** The Stellar button's config, or null when the rail cannot run in a browser here. */
  stellar: StellarCheckoutConfig | null;
  owner: string;
  slug: string;
  version: string;
  priceMicro: string;
  updatePriceMicro: string;
  priceLabel: string;
  updatePriceLabel: string;
  sizeLabel?: string;
  forSale: boolean;
};

/** Per browser, per site, not per listing: a buyer's wallet does not change with the repo. */
export const LAST_RAIL_KEY = "x402git.pay.rail";

const GET_EVM_WALLET = "https://metamask.io/download/";

/** The Stellar row's line before connect: the kit's picker, by the wallets that can pay in it. */
export const STELLAR_WALLETS_LINE = "Stellar wallets: Freighter, Hana, HOT…";

/**
 * The options this page can render a working button for, in the 402's order. An EVM
 * option with no chain facts, or a Stellar option the browser cannot pay (rail off or on
 * another network), is left out rather than shown as a row that cannot work; the page's
 * terminal disclosure still covers Stellar.
 */
export function payRows(options: Props["options"], chains: EvmChain[], stellar: StellarCheckoutConfig | null): PayRow[] {
  const rows: PayRow[] = [];
  for (const option of options) {
    if (rows.some((r) => r.network === option.network)) continue;
    if (option.network.startsWith("eip155:")) {
      const chain = chains.find((c) => c.network === option.network);
      if (chain) rows.push({ kind: "evm", network: option.network, symbol: option.asset_symbol || chain.symbol, chain });
    } else if (option.network.startsWith("stellar:") && stellar && stellar.network === option.network) {
      rows.push({ kind: "stellar", network: option.network, symbol: stellar.asset.symbol, chainName: chainLabel(option.network), config: stellar });
    }
  }
  return rows;
}

/**
 * Last used here → the first EVM row when an EVM wallet is injected → the Stellar row once
 * the EVM question has been answered no → the first row. Null only for no rows.
 */
export function preselect(rows: Pick<PayRow, "kind" | "network">[], lastUsed: string | null, detected: Detected): string | null {
  if (rows.length === 0) return null;
  if (lastUsed && rows.some((r) => r.network === lastUsed)) return lastUsed;
  const pick = detected.evm ? rows.find((r) => r.kind === "evm") : detected.evm === null ? rows.find((r) => r.kind === "stellar") : undefined;
  return (pick ?? rows[0]).network;
}

function readLastRail(): string | null {
  try {
    return window.localStorage.getItem(LAST_RAIL_KEY);
  } catch {
    return null;
  }
}

function rememberRail(network: string): void {
  try {
    window.localStorage.setItem(LAST_RAIL_KEY, network);
  } catch {
    // Private mode, blocked storage: the next visit preselects by wallet instead.
  }
}

export function PayBlock(props: Props) {
  const { options, chains, stellar } = props;
  const rows = payRows(options, chains, stellar);
  const groupId = useId();

  const [mounted, setMounted] = useState(false);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected>({ evm: undefined });
  const [picked, setPicked] = useState<string | null>(null);
  /** The wallet chosen in the Stellar row's picker, while its button holds it. */
  const [stellarWallet, setStellarWallet] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    setLastUsed(readLastRail());

    // Extensions inject at document start; MetaMask also announces a late injection.
    const readEvm = () => {
      const provider = detectProvider(window as unknown as ProviderRoot);
      setDetected({ evm: provider ? walletName(provider) : null });
    };
    readEvm();
    window.addEventListener("ethereum#initialized", readEvm, { once: true });
    return () => window.removeEventListener("ethereum#initialized", readEvm);
  }, []);

  // Before mount there is no storage and no wallet to read: the first row, on both sides
  // of hydration, so the server HTML and the first client render agree.
  const auto = mounted ? preselect(rows, lastUsed, detected) : (rows[0]?.network ?? null);
  const selected = picked ?? auto;

  /** The first touch fixes the pick, so a late `ethereum#initialized` cannot move the button. */
  const hold = useCallback(() => {
    if (mounted) setPicked((p) => p ?? auto);
  }, [auto, mounted]);

  const choose = useCallback((network: string) => {
    setPicked(network);
    rememberRail(network);
  }, []);

  if (rows.length === 0) return null;

  const action = (row: PayRow) => (
    <div className="pay-action" onClickCapture={() => (mounted ? rememberRail(row.network) : undefined)}>
      {row.kind === "evm" ? (
        <BuyWithWallet
          owner={props.owner}
          slug={props.slug}
          version={props.version}
          priceMicro={props.priceMicro}
          updatePriceMicro={props.updatePriceMicro}
          priceLabel={props.priceLabel}
          updatePriceLabel={props.updatePriceLabel}
          chainId={row.chain.chainId}
          chainName={row.chain.chainName}
          symbol={row.symbol}
          explorer={row.chain.explorer || undefined}
          walletName={detected.evm ?? null}
          forSale={props.forSale}
          sizeLabel={props.sizeLabel}
        />
      ) : (
        <BuyWithStellar
          owner={props.owner}
          slug={props.slug}
          version={props.version}
          priceMicro={props.priceMicro}
          priceLabel={props.priceLabel}
          chainName={row.chainName}
          config={row.config}
          forSale={props.forSale}
          sizeLabel={props.sizeLabel}
          onWallet={setStellarWallet}
        />
      )}
    </div>
  );

  // One way to pay: the chip says what it is, the button does it. No choice, no radios.
  if (rows.length === 1) {
    const row = rows[0];
    return (
      <div className="pay-block" data-single="">
        <p className="pay-one">
          <RailChip network={row.network} symbol={row.symbol} />
        </p>
        {action(row)}
      </div>
    );
  }

  // The tree has the same shape before and after mount — only each row's first child
  // changes, from a static chip to a label with its radio — so the chosen row's button
  // is not remounted by the block's own hydration.
  return (
    <div
      className="pay-block"
      role={mounted ? "radiogroup" : undefined}
      aria-labelledby={mounted ? `${groupId}-label` : undefined}
      onPointerDownCapture={hold}
      onKeyDownCapture={hold}
      onFocusCapture={hold}
    >
      <p className="pay-label" id={`${groupId}-label`}>
        Pay with
      </p>
      {rows.map((row) => {
        const isSelected = row.network === selected;
        const statusId = `${groupId}-${row.network}`;
        return (
          <div className="pay-row" key={row.network} data-selected={isSelected ? "" : undefined}>
            {mounted ? (
              <div className="pay-line">
                <label className="pay-pick">
                  <input
                    type="radio"
                    name={`${groupId}-rail`}
                    value={row.network}
                    checked={isSelected}
                    onChange={() => choose(row.network)}
                    aria-describedby={statusId}
                  />
                  <span className="pay-dot" aria-hidden="true" />
                  <RailChip network={row.network} symbol={row.symbol} />
                </label>
                <span className="pay-wallet" id={statusId}>
                  <WalletLine row={row} detected={detected} stellarWallet={isSelected ? stellarWallet : null} />
                </span>
              </div>
            ) : (
              <span className="pay-line">
                <RailChip network={row.network} symbol={row.symbol} />
              </span>
            )}
            {isSelected ? action(row) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The wallet this row would use, said in as few words as hold it — or where to get one. */
export function WalletLine({ row, detected, stellarWallet }: { row: Pick<PayRow, "kind">; detected: Detected; stellarWallet: string | null }) {
  if (row.kind === "evm") {
    if (detected.evm === undefined) return null;
    if (detected.evm) return <>{detected.evm} detected</>;
    return (
      <>
        No EVM wallet,{" "}
        <a href={GET_EVM_WALLET} rel="noopener noreferrer" target="_blank">
          get one
        </a>
      </>
    );
  }
  // Which Stellar wallets are installed is the picker's to find; this line only names them.
  if (stellarWallet) return <>{stellarWallet} connected</>;
  return <>{STELLAR_WALLETS_LINE}</>;
}
