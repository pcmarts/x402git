import { describe, expect, it } from "vitest";
import { CHECKOUT_MESSAGES } from "./wallet-checkout";
import { NETWORK_TOKEN, withNetwork } from "./checkout-copy";

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

  it("names the chain in the two messages that need one, and only there", () => {
    const templated = Object.entries(CHECKOUT_MESSAGES)
      .filter(([, m]) => m.includes(NETWORK_TOKEN))
      .map(([code]) => code)
      .sort();
    expect(templated).toEqual(["insufficient_balance", "wrong_chain"]);
  });

  it("renders both correctly on either deployment", () => {
    expect(withNetwork(CHECKOUT_MESSAGES.insufficient_balance, "Base")).toBe("Not enough USDC on Base — top up and try again.");
    expect(withNetwork(CHECKOUT_MESSAGES.wrong_chain, "Base Sepolia")).toContain("Switch it to Base Sepolia");
  });
});
