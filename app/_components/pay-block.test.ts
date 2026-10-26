/**
 * The pay block (pay-block.tsx, 25 Oct 2026): which rows it draws, which one it picks for
 * the buyer, and what a reader without script gets. The pick is the part worth pinning —
 * a wrong one puts the button on a rail whose wallet is not installed — so `preselect` is
 * tested as a function, and the server render through `renderToStaticMarkup`, which is
 * the bytes `curl` receives (no effects run, so no storage and no wallet are read).
 *
 * 25 Oct 2026, ~21:30 (the wallet kit): Freighter is no longer asked on load, so the pick
 * reads the EVM answer alone, and the Stellar row's line names the kit's wallets until one
 * is chosen.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StellarCheckoutConfig } from "@/lib/web/stellar-checkout";
import { type EvmChain, PayBlock, payRows, preselect, rowLocked, STELLAR_WALLETS_LINE, WalletLine } from "./pay-block";
import { rowSymbol } from "./purchases";

const BASE: EvmChain = { network: "eip155:8453", chainId: 8453, chainName: "Base", explorer: "https://basescan.org", symbol: "USDC" };
const ARBITRUM: EvmChain = { network: "eip155:42161", chainId: 42161, chainName: "Arbitrum", explorer: "https://arbiscan.io", symbol: "USDT0" };
const STELLAR: StellarCheckoutConfig = {
  network: "stellar:pubnet",
  passphrase: "Public Global Stellar Network ; September 2015",
  rpcUrl: "https://rpc.example",
  horizonUrl: "https://horizon.stellar.org",
  asset: { code: "USDT0", issuer: "G".padEnd(56, "A"), contract: "C".padEnd(56, "A"), symbol: "USDT0" },
};

const ALL = [
  { network: "eip155:42161", asset_symbol: "USDT0" },
  { network: "eip155:8453", asset_symbol: "USDC" },
  { network: "stellar:pubnet", asset_symbol: "USDT0" },
];

const none = { evm: null } as const;

describe("payRows: only what the page can make work", () => {
  it("keeps the 402's order, one row per option", () => {
    expect(payRows(ALL, [BASE, ARBITRUM], STELLAR).map((r) => [r.kind, r.network, r.symbol])).toEqual([
      ["evm", "eip155:42161", "USDT0"],
      ["evm", "eip155:8453", "USDC"],
      ["stellar", "stellar:pubnet", "USDT0"],
    ]);
  });

  it("drops an EVM option with no chain facts, and a Stellar option the browser cannot pay", () => {
    expect(payRows(ALL, [BASE], null).map((r) => r.network)).toEqual(["eip155:8453"]);
    expect(payRows(ALL, [BASE, ARBITRUM], { ...STELLAR, network: "stellar:testnet" }).map((r) => r.network)).toEqual(["eip155:42161", "eip155:8453"]);
  });

  it("names the Stellar row in the words chainLabel uses", () => {
    const [row] = payRows([{ network: "stellar:pubnet", asset_symbol: "USDT0" }], [], STELLAR);
    expect(row).toMatchObject({ kind: "stellar", chainName: "Stellar" });
  });
});

describe("preselect: last used → EVM wallet → Stellar row → first", () => {
  const rows = payRows(ALL, [BASE, ARBITRUM], STELLAR);

  it("takes the row last used in this browser, when the listing still offers it", () => {
    expect(preselect(rows, "eip155:8453", { evm: "MetaMask" })).toBe("eip155:8453");
    expect(preselect(rows, "stellar:pubnet", { evm: "MetaMask" })).toBe("stellar:pubnet");
  });

  it("ignores a remembered rail this listing does not take", () => {
    expect(preselect(rows, "eip155:1", { evm: "MetaMask" })).toBe("eip155:42161");
  });

  it("puts a browser with an EVM wallet on the first EVM row", () => {
    expect(preselect(rows, null, { evm: "MetaMask" })).toBe("eip155:42161");
    expect(preselect(rows.slice(2).concat(rows.slice(0, 2)), null, { evm: "Coinbase Wallet" })).toBe("eip155:42161");
  });

  it("puts a browser with no EVM wallet on the Stellar row, whose picker covers having none", () => {
    expect(preselect(rows, null, none)).toBe("stellar:pubnet");
  });

  it("falls back to the first row before the EVM question is answered, or with no Stellar row", () => {
    expect(preselect(rows, null, { evm: undefined })).toBe("eip155:42161");
    expect(preselect(rows.slice(0, 2), null, none)).toBe("eip155:42161");
  });

  it("has nothing to pick with no rows", () => {
    expect(preselect([], "eip155:8453", { evm: "MetaMask" })).toBeNull();
  });
});

describe("the wallet line beside each row", () => {
  const line = (kind: "evm" | "stellar", evm: string | null | undefined, stellarWallet: string | null = null) =>
    renderToStaticMarkup(createElement(WalletLine, { row: { kind }, detected: { evm }, stellarWallet }));

  it("names the kit's wallets on the Stellar row before connect, and asks no extension", () => {
    expect(STELLAR_WALLETS_LINE).toBe("Stellar wallets: Freighter, Hana, HOT…");
    expect(line("stellar", undefined)).toBe("Stellar wallets: Freighter, Hana, HOT…");
    expect(line("stellar", "MetaMask")).toBe("Stellar wallets: Freighter, Hana, HOT…");
    expect(line("stellar", null)).not.toContain("Get Freighter");
  });

  it("names the wallet chosen in the picker once connected", () => {
    expect(line("stellar", null, "Hana")).toBe("Hana connected");
    expect(line("stellar", null, "Freighter")).toBe("Freighter connected");
  });

  it("keeps the EVM row's detected wallet, and says nothing when there is none", () => {
    expect(line("evm", undefined)).toBe("");
    expect(line("evm", "MetaMask")).toBe("MetaMask detected");
    expect(line("evm", null)).toBe("");
  });
});

describe("the server render: static rows and one fallback line", () => {
  const props = {
    chains: [BASE, ARBITRUM],
    stellar: STELLAR,
    owner: "adrian",
    slug: "humanizer",
    version: "1.2.0",
    priceMicro: "9000000",
    updatePriceMicro: "5000000",
    priceLabel: "$9",
    updatePriceLabel: "$5",
    forSale: true,
  };

  it("draws every row as a chip, no radios, and the first row's own fallback once", () => {
    const html = renderToStaticMarkup(createElement(PayBlock, { ...props, options: ALL }));
    expect(html).toContain("Pay with");
    expect(html.split('class="pay-row"').length - 1).toBe(3);
    expect(html).toContain("USDT0 on Arbitrum");
    expect(html).toContain("USDC on Base");
    expect(html).toContain("USDT0 on Stellar");
    expect(html).not.toContain('type="radio"');
    expect(html.split("Turn on JavaScript").length - 1).toBe(1);
    // The first row is the chosen one before mount, and carries the button's slot.
    expect(html.indexOf("data-selected")).toBeLessThan(html.indexOf("USDC on Base"));
  });

  it("is the chip and the button alone when there is one way to pay", () => {
    const html = renderToStaticMarkup(createElement(PayBlock, { ...props, options: [ALL[2]] }));
    expect(html).toContain("data-single");
    expect(html).toContain("USDT0 on Stellar");
    expect(html).not.toContain("Pay with");
    expect(html).toContain("Turn on JavaScript to pay from this page with a Stellar wallet");
  });

  it("renders nothing for options it cannot make a button for", () => {
    expect(renderToStaticMarkup(createElement(PayBlock, { ...props, chains: [], stellar: null, options: ALL }))).toBe("");
  });
});

describe("the purchases row's token (purchases.tsx)", () => {
  const rails = { "eip155:42161": { asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT0" } };

  it("names the row's token from its network and contract", () => {
    expect(rowSymbol({ network: "eip155:42161", asset: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" }, rails)).toBe("USDT0");
    expect(rowSymbol({ network: "eip155:42161", asset: null }, rails)).toBe("USDT0");
  });

  it("names nothing it cannot vouch for", () => {
    expect(rowSymbol({ network: null, asset: null }, rails)).toBeNull();
    expect(rowSymbol({ network: "eip155:42161", asset: "0x0000000000000000000000000000000000000001" }, rails)).toBeNull();
    expect(rowSymbol({ network: "eip155:1", asset: null }, rails)).toBeNull();
  });
});

describe("rowLocked: the other rows wait while one button works or has paid (26 Oct 2026)", () => {
  it("locks nothing at rest, and every row but the chosen one while busy or done", () => {
    expect(rowLocked(null, false)).toBe(false);
    expect(rowLocked(null, true)).toBe(false);
    expect(rowLocked("busy", false)).toBe(true);
    expect(rowLocked("busy", true)).toBe(false);
    expect(rowLocked("done", false)).toBe(true);
    expect(rowLocked("done", true)).toBe(false);
  });
});
