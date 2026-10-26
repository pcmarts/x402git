/**
 * lib/web/faq.ts — the questions creators and buyers actually ask, with the answers
 * the product gives. One module on purpose: the answers render on /how-it-works, feed
 * its `FAQPage` structured data, and (a founder-picked five of them, 2026-08-31) close
 * the home page — and every rendering must say the same thing.
 */

/** `a` is plain text on purpose: it is rendered *and* emitted as structured data. */
export type QA = { q: string; a: string };
export const FAQ: { group: string; items: QA[] }[] = [
  {
    group: "Selling",
    items: [
      {
        q: "Can buyers see my code before they pay?",
        a: "No. Before paying, anyone can see the file list with sizes, the language mix, the licence, the rendered README, the release log and the scan verdict. The source itself is served only after a payment settles, as a .zip of the exact bytes that were scanned.",
      },
      {
        q: "How do agents find my listing?",
        a: "Once it is live we push it to the places agents look, without you doing anything: the x402 indexes (x402scan, and the x402 Bazaar from its first sale), the official MCP Registry through our buy-side server, and the search engines, which are told the moment your page changes. Your own audience is still the shortest path — link the page from your README, your posts and your videos.",
      },
      {
        q: "Does my repository have to leave GitHub?",
        a: "No. You install the GitHub App on one repository and keep working there. Every tag you push is snapshotted and scanned here; the repository itself stays private on GitHub.",
      },
      {
        q: "What happens when I push a new release?",
        a: "It is snapshotted, licence-checked and scanned for secrets and known vulnerabilities. If it passes, it goes on sale: new buyers pay the price, and everyone who already bought is offered it at the update price. If it fails, nothing changes — the listing keeps selling its last passing release and you see the findings.",
      },
      {
        q: "Can I change my prices later?",
        a: "Yes, any time, and only future purchases are affected. Each purchase carries the update price it was made at, and a holder pays that or the current update price, whichever is lower. A purchase made with updates at $0 includes every future release, permanently.",
      },
      {
        q: "Do I need a crypto wallet?",
        a: "You need an address to be paid at: an EVM wallet that holds USDC on Base, a Stellar wallet (Freighter, Hana, HOT, xBull, Lobstr and others) that holds USDT0, or one of each. You prove you control it by signing one message; no funds move. The server never sees a private key, yours or anyone's.",
      },
      {
        q: "Do I need to do KYC or file tax forms to get paid?",
        a: "No. Payouts are not gated on identity. Every payout address is screened against sanctions lists, which is a check on the address, not on you. Tax on what you earn is your responsibility, as it would be anywhere.",
      },
      {
        q: "Can I stop selling?",
        a: "Yes. Retiring a listing stops new purchases. Everyone who already bought keeps every version they own and can still download it; the listing page and its release log stay up, marked no longer sold. Uninstalling the GitHub App does the same thing.",
      },
    ],
  },
  {
    group: "Buying",
    items: [
      {
        q: "Do I need an account?",
        a: "No. You need a wallet that holds dollars: USDC on Base, or USDT0 on Stellar for listings that take it. Your purchases are tied to that wallet's address, and you can list and re-download them at any time by signing a message with it.",
      },
      {
        q: "What exactly do I get?",
        a: "A .zip of the repository at the version you paid for, with its LICENSE and attribution included. It is the exact snapshot that was scanned, and the download link can be regenerated for as long as your wallet exists.",
      },
      {
        q: "Am I charged for updates automatically?",
        a: "Never. When a new release ships you are shown what changed and what it costs, and you are charged only if you choose to take it. If you bought with updates at $0, every new release is already yours.",
      },
      {
        q: "Can the creator take back what I bought?",
        a: "No. A buyer never loses a purchased version to a creator action — not a price change, not a retirement, not a deleted repository. The only thing that can revoke a purchase is a takedown by the platform, and that refunds you from the holdback.",
      },
      {
        q: "Does the creator see who bought?",
        a: "No. Creators see a sale — the version, the kind, the amount and the time — and never a buyer's address or transaction hash. Payments to the platform address are, like everything on a public chain, visible on Base or on Stellar, whichever the buyer paid on.",
      },
      {
        q: "Can my agent buy without me?",
        a: "Yes. Every listing is an x402 endpoint. An agent with a funded wallet fetches the repository, gets a 402 with the price, pays it within whatever budget you set, and downloads — with no person in the loop. It checks the version endpoint before each run and reads the changelog before deciding to pay for an update.",
      },
    ],
  },
  {
    group: "Money",
    items: [
      {
        q: "What does it cost to list?",
        a: "Nothing. The platform's only revenue is 10% of each payment. There is no listing fee, no monthly fee and no payout fee. At $9 you keep $8.10.",
      },
      {
        q: "When do I get paid?",
        a: "Seven days after each sale settles, your 90% sweeps to the wallet you bound. The holdback is fixed, the same for everyone, and it is the only time this platform holds money you have earned.",
      },
      {
        q: "Why USDC on Base, and what about gas?",
        a: "Prices are set in dollars, and both tokens are a dollar: USDC on Base, USDT0 on Stellar. Base is where x402 settles cheaply, and gas is sponsored, so a buyer needs only USDC and a creator needs only an address. On Stellar the network fee is sponsored the same way, so a buyer needs only USDT0 in a Stellar wallet (Freighter) and a creator needs only a Stellar address. Nobody on either side has to hold ETH.",
      },
      {
        q: "Can I send my earnings somewhere else?",
        a: "Only to the address you bound. There is no field anywhere in the product for a different destination, which is what makes a leaked API key useless to a thief. Changing the bound address requires a signature from the current one.",
      },
      {
        q: "Are there refunds?",
        a: "A refund happens when the platform takes a listing down, and it is paid from the holdback. That is the only path that revokes a purchase, and it is logged. Buyer-initiated refunds are not in this version.",
      },
    ],
  },
];

/**
 * The open-release questions a maintainer asks (25 Oct 2026, HackMeridian). They render
 * in full on /open-source and, a five of them, close the home page (26 Oct 2026). Not a
 * group of `FAQ` on purpose: /how-it-works and its `FAQPage` stay about the money side
 * every listing shares.
 */
export const OPEN_RELEASE_FAQ: QA[] = [
  {
    q: "So you are closing open source?",
    a: "No. Only new releases, only until a date you commit to publicly, always under an OSI licence. Code that is already public is never restricted, and the platform refuses to list a public repository at all.",
  },
  {
    q: "The first buyer can just republish it.",
    a: "Yes. The licence allows that. Buyers pay to fund the work and get it first, with a scanned, hash-pinned build. Sponsorware has shown for years that people pay for exactly that.",
  },
  {
    q: "How do you know it really opened?",
    a: "After the date, we ask GitHub whether the public repository contains the exact commit that was sold, under the same licence. The listing then says Opened on time, with a link to the public commit, or Overdue. The same answer is in the listing JSON and in the MCP tool an agent reads.",
  },
  {
    q: "Who holds the money?",
    a: "A buyer pays in USDT0 on Stellar; the payment lands at the platform's account and 90% is forwarded to your project's Stellar address. The address and every payout are on chain. The platform's fee is 10%.",
  },
  {
    q: "Is this crypto?",
    a: "There is no token. Your project receives dollars, as USDT0, which can be moved to whichever chain you keep them on or cashed out through a Stellar anchor.",
  },
  {
    q: "Paying contributors will attract slop PRs.",
    a: "The project decides who gets paid. Nothing is paid out by metric, and sending a pull request to a listed repository earns nothing automatically.",
  },
];

/**
 * The questions the home page closes with, by exact question text. A missing
 * question is a build-time throw, not a silently shorter FAQ, so a reworded
 * question on /how-it-works or /open-source cannot quietly drop it from the home page.
 */
export function faqItems(questions: string[]): QA[] {
  const all = [...FAQ.flatMap((group) => group.items), ...OPEN_RELEASE_FAQ];
  return questions.map((q) => {
    const hit = all.find((item) => item.q === q);
    if (!hit) throw new Error(`FAQ question not found: ${q}`);
    return hit;
  });
}
