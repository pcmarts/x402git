#!/usr/bin/env node
/**
 * scripts/b4-fund-sweep-wallet.mjs — BLOCKERS.md B4: fund the sweep signer.
 *
 *   node scripts/b4-fund-sweep-wallet.mjs
 *
 * The sweep wallet (`sweep-wallet.local.json`, generated for B4) starts empty. The
 * FR-34 second pass needs it to hold the 540000 micro-USDC it will owe the four rail
 * creators, plus Base Sepolia ETH for gas. Wallet B — the funded test buyer,
 * `TEST_BUYER_PRIVATE_KEY` in `.env` — is the only funded key this repo holds, so it
 * does the funding: one ETH transfer, one USDC transfer, both idempotent (a re-run
 * against an already-funded wallet sends nothing).
 *
 * Testnet only. Neither key is read beyond signing, and neither is printed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = (() => {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env"), "utf8")
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => {
          const i = l.indexOf("=");
          let v = l.slice(i + 1).trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n");
          return [l.slice(0, i), v];
        }),
    );
  } catch {
    return {};
  }
})();

const USDC = env.X402_ASSET_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC = env.EVM_RPC_URL ?? "https://sepolia.base.org";

/** What the sweep wallet must end up holding. Gas on Base Sepolia is µETH-scale per
 * transfer.
 *
 * **Raised from 600000 on 2026-09-06, after the first real sweep ran short.** The
 * original figure came from B4's estimate of "four rail creators × 135000". The 03:00
 * UTC cron found **nine** creators with released balances, not four — five at 90000
 * (a $0.10 sale) and four at 135000 ($0.15) — owing 1035000 in total. It paid the first
 * five (495000), reverted on the sixth for insufficient USDC, and left three more
 * `pending` and blocking. The lesson is not the arithmetic: it is that this target was a
 * guess about a set the ledger already knew the size of, so it is now set well clear of
 * it rather than close to it. */
const TARGET_USDC_MICRO = 1000000n;
const TARGET_ETH = parseEther("0.00008");

const buyerKey = env.TEST_BUYER_PRIVATE_KEY;
if (!buyerKey) {
  console.error("FAIL: TEST_BUYER_PRIVATE_KEY is not in .env — nothing here can fund anything.");
  process.exit(1);
}
const sweep = JSON.parse(fs.readFileSync(path.join(ROOT, "sweep-wallet.local.json"), "utf8"));

const chain = {
  id: 84532,
  name: "eip155:84532",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const client = createPublicClient({ chain, transport: http(RPC) });
const buyer = createWalletClient({ account: privateKeyToAccount(buyerKey), chain, transport: http(RPC) });

const usdcOf = (a) => client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

/**
 * An RPC URL can *be* a credential: CDP embeds the client API key in the path
 * (`…/rpc/v1/base/<key>`), and so do Alchemy and Infura. Printing one to a terminal
 * puts it in scrollback, in whatever gets pasted into an issue, and in CI logs. Print
 * the host and the shape, never the last segment.
 */
function safeRpc(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? `${u.origin}/${parts.slice(0, -1).concat("…").join("/")}` : u.origin;
  } catch {
    return "(unparseable rpc url)";
  }
}

console.log(`funding sweep wallet ${sweep.address} from wallet B ${buyer.account.address} (rpc ${safeRpc(RPC)})`);
const [ethBal, usdcBal] = [await client.getBalance({ address: sweep.address }), await usdcOf(sweep.address)];
console.log(`sweep wallet holds ${formatEther(ethBal)} ETH, ${Number(usdcBal) / 1e6} USDC`);

const wait = async (hash, label) => {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") {
    console.error(`FAIL: ${label} reverted — https://sepolia.basescan.org/tx/${hash}`);
    process.exit(1);
  }
  console.log(`  ok: ${label} — https://sepolia.basescan.org/tx/${hash}`);
};

if (ethBal < TARGET_ETH) {
  await wait(await buyer.sendTransaction({ to: sweep.address, value: TARGET_ETH - ethBal }), `${formatEther(TARGET_ETH - ethBal)} ETH for gas`);
} else {
  console.log("  ok: enough ETH already, nothing sent");
}

if (usdcBal < TARGET_USDC_MICRO) {
  const amount = TARGET_USDC_MICRO - usdcBal;
  await wait(
    await buyer.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [sweep.address, amount] }),
    `${Number(amount) / 1e6} USDC`,
  );
} else {
  console.log("  ok: enough USDC already, nothing sent");
}

console.log(
  `funded: ${formatEther(await client.getBalance({ address: sweep.address }))} ETH, ` +
    `${Number(await usdcOf(sweep.address)) / 1e6} USDC at https://sepolia.basescan.org/address/${sweep.address}`,
);
