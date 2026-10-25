/**
 * app/_components/rail-marks.tsx — the token and the chain, as marks (25 Oct 2026, HackMeridian).
 *
 * A buyer choosing how to pay and a creator reading where money landed both need the same
 * two facts at a glance: which token, on which chain. These are the marks for them, drawn
 * from `public/logos` (USDT0 from Tether's kit, Arbitrum from arbitrum.foundation, Stellar's
 * rocket from its brand kit drawn in the text colour so it reads on both themes, and Base as
 * the plain `#00F` disc the founder asked for on 25 Oct), with the symbol as text where no
 * mark is held. Server components: plain `<img>`, no script, `alt=""` because the words beside the
 * mark carry the meaning and a screen reader should not hear "USDT0 USDT0 on Arbitrum".
 *
 * One rule: a mark never stands alone. `RailChip` always prints "<token> on <chain>" next
 * to the marks, so a reader who does not know a logo still knows what they are looking at.
 */

import { chainLabel } from "@/lib/buy-links";

const TOKEN_MARKS: Record<string, string> = {
  USDT0: "/logos/usdt0.svg",
  USDC: "/logos/usdc.svg",
};

const CHAIN_MARKS: Record<string, string> = {
  "eip155:42161": "/logos/arbitrum.svg",
  "eip155:8453": "/logos/base.svg",
  "eip155:84532": "/logos/base.svg",
  "stellar:pubnet": "/logos/stellar.svg",
  "stellar:testnet": "/logos/stellar.svg",
};

/** Marks we actually hold a file for; the rest fall back to text. */
const HELD = new Set(["/logos/usdt0.svg", "/logos/arbitrum.svg", "/logos/base.svg", "/logos/stellar.svg"]);

function Mark({ src, text }: { src: string | undefined; text: string }) {
  if (src && HELD.has(src)) return <img className="mark" src={src} alt="" width={16} height={16} loading="lazy" decoding="async" />;
  return (
    <span className="mark mark-text" aria-hidden="true">
      {text.slice(0, 1)}
    </span>
  );
}

export function TokenMark({ symbol }: { symbol: string }) {
  return <Mark src={TOKEN_MARKS[symbol.toUpperCase()]} text={symbol} />;
}

export function ChainMark({ network }: { network: string }) {
  return <Mark src={CHAIN_MARKS[network]} text={chainLabel(network)} />;
}

/**
 * "USDT0 on Arbitrum", with both marks. `short` drops the chain mark for dense tables,
 * where two circles per row is noise and the words still say everything.
 */
export function RailChip({ network, symbol, short = false }: { network: string; symbol: string; short?: boolean }) {
  return (
    <span className="rail-chip" data-network={network}>
      <TokenMark symbol={symbol} />
      {short ? null : <ChainMark network={network} />}
      <span className="rail-chip-text">
        {symbol} on {chainLabel(network)}
      </span>
    </span>
  );
}

/** The symbol for a stored `asset` address on a network, when the deployment knows it; else a short address. */
export function symbolForAsset(network: string, asset: string | null, known: Record<string, { asset: string; symbol: string }>): string {
  if (!asset) return network.startsWith("stellar:") ? "USDT0" : "USDC";
  const rail = known[network];
  if (rail && rail.asset.toLowerCase() === asset.toLowerCase()) return rail.symbol;
  return `${asset.slice(0, 6)}…`;
}
