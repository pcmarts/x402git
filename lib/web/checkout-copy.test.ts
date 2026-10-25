import { describe, expect, it } from "vitest";
import { CHECKOUT_MESSAGES } from "./wallet-checkout";
import { detectProvider, type Eip1193Provider, NETWORK_TOKEN, TOKEN_TOKEN, walletName, withNetwork, withRail } from "./checkout-copy";

describe("the chain name in checkout copy", () => {
  it("substitutes the deployment's chain", () => {
    expect(withNetwork(`Not enough USDC on ${NETWORK_TOKEN} — top up.`, "Base")).toBe("Not enough USDC on Base — top up.");
  });

  it("leaves a message with no placeholder alone", () => {
    expect(withNetwork("Cancelled in your wallet.", "Base")).toBe("Cancelled in your wallet.");
  });

  /**
   * The defect. `insufficient_balance` said "Base Sepolia" and `wrong_chain` said
   * "Base" — each one wrong on the deployment the other was right on, and the second
   * about to be wrong for every buyer on mainnet.
   */
  it("leaves no chain named literally in any message", () => {
    for (const [code, message] of Object.entries(CHECKOUT_MESSAGES)) {
      expect(message, `${code} names a chain literally`).not.toMatch(/Base\b/);
      expect(message, `${code} names a chain literally`).not.toMatch(/Sepolia/);
    }
  });

  it("names the chain in the three messages that need one, and only there", () => {
    const templated = Object.entries(CHECKOUT_MESSAGES)
      .filter(([, m]) => m.includes(NETWORK_TOKEN))
      .map(([code]) => code)
      .sort();
    expect(templated).toEqual(["insufficient_balance", "rail_unavailable", "wrong_chain"]);
  });

  it("renders them correctly on either deployment", () => {
    expect(withRail(CHECKOUT_MESSAGES.insufficient_balance, { network: "Base", token: "USDC" })).toBe("Not enough USDC on Base — top up and try again.");
    expect(withNetwork(CHECKOUT_MESSAGES.wrong_chain, "Base Sepolia")).toContain("Switch it to Base Sepolia");
  });
});

/**
 * 25 Oct 2026 (EVM USDT0): the same defect, one field over. With Arbitrum USDT0 beside
 * Base USDC, a catalogue that spelled "USDC" would tell an Arbitrum buyer to top up the
 * wrong token.
 */
describe("the token in checkout copy", () => {
  it("substitutes the row's token and chain together", () => {
    expect(withRail(CHECKOUT_MESSAGES.insufficient_balance, { network: "Arbitrum", token: "USDT0" })).toBe("Not enough USDT0 on Arbitrum — top up and try again.");
    expect(withRail(CHECKOUT_MESSAGES.rail_unavailable, { network: "Arbitrum", token: "USDT0" })).toBe(
      "This listing no longer takes USDT0 on Arbitrum. Reload the page to see how to pay.",
    );
  });

  it("leaves no token named literally in any message", () => {
    for (const [code, message] of Object.entries(CHECKOUT_MESSAGES)) {
      expect(message, `${code} names a token literally`).not.toMatch(/USDC|USDT0|USD₮0/);
    }
  });

  it("fills every placeholder, so none reaches a reader", () => {
    for (const message of Object.values(CHECKOUT_MESSAGES)) {
      const filled = withRail(message, { network: "Arbitrum", token: "USDT0" });
      expect(filled).not.toContain(NETWORK_TOKEN);
      expect(filled).not.toContain(TOKEN_TOKEN);
    }
  });
});

describe("the injected wallet, named without loading the checkout", () => {
  const wallet = (flags: Partial<Eip1193Provider>) => ({ request: async () => null, ...flags }) as Eip1193Provider;

  it("names the wallet detectProvider would use", () => {
    expect(walletName(wallet({ isMetaMask: true }))).toBe("MetaMask");
    expect(walletName(wallet({ isCoinbaseWallet: true }))).toBe("Coinbase Wallet");
    // Rabby also claims isMetaMask; it is still Rabby.
    expect(walletName(wallet({ isRabby: true, isMetaMask: true }))).toBe("Rabby");
    expect(walletName(wallet({}))).toBe("Wallet");
  });

  it("keeps the preference order when several extensions collide", () => {
    const metamask = wallet({ isMetaMask: true });
    const coinbase = wallet({ isCoinbaseWallet: true });
    const picked = detectProvider({ ethereum: wallet({ providers: [metamask, coinbase] }) });
    expect(picked).toBe(coinbase);
    expect(detectProvider(undefined)).toBeNull();
  });
});
