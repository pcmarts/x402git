"use client";

/**
 * app/_components/payout-summary.tsx — the seller's side of the sale, itemised, and
 * live against the price form beside it.
 *
 * The buy box seen from the other end of the same transaction: what a buyer pays, what
 * the platform takes, what lands in the bound wallet. It reuses the buy box's rectangle
 * rather than earning a third box shape.
 *
 * Two rules hold it honest.
 *
 * 1. **The server HTML is the saved record.** State starts at the props, which are the
 *    values in the database, so `curl` and a reader with scripting off get the listing's
 *    real terms and nothing that only exists in a browser. `check:ssr` sees the same
 *    numbers a signed-in creator does.
 * 2. **A preview says it is a preview.** Once the form disagrees with the record, the
 *    box prints the form's arithmetic *and* a line saying it is not saved yet. A box
 *    that silently swapped in unsaved numbers would be the most expensive kind of lie
 *    on this page — a creator reading "$49.00 → you receive $44.10" and closing the tab.
 *
 * The arithmetic is the shipping arithmetic: `splitFee` from `lib/core/fee.ts` (which
 * `lib/core/access.ts` re-exports and settlement calls) and `formatAmount` from
 * `money-format.ts`. Nothing here computes money a second way.
 *
 * The box used to end with "Paid to" and the bound address. That left on 25 Oct 2026
 * (founder: "confusing as we also have 'Where you get paid' in the main body"): a creator
 * can now hold two payout addresses, one per rail family, and the rows in the form name
 * each beside the rail it serves. This box is the money; the rows are where it lands.
 */

import { useEffect, useState } from "react";
import { splitFee } from "@/lib/core/fee";
import { formatAmount, parsePriceInput } from "@/lib/web/money-format";

type Props = {
  /** Micro-USDC as decimal strings: a bigint cannot cross the server/client boundary. */
  priceMicro: string;
  updatePriceMicro: string;
  feeBps: string;
  /** The `id` of the form whose price fields this box watches. */
  formId: string;
};

export function PayoutSummary({ priceMicro, updatePriceMicro, feeBps, formId }: Props) {
  const saved = { price: BigInt(priceMicro), update: BigInt(updatePriceMicro) };
  const [live, setLive] = useState(saved);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    // Re-derived inside the effect rather than closed over from the render, so every
    // value it reads is either a prop in the dependency list or defined right here.
    const fallback = { price: BigInt(priceMicro), update: BigInt(updatePriceMicro) };

    const read = () => {
      const data = new FormData(form);
      setLive({
        price: chosen(data.get("price_choice"), data.get("price_custom"), fallback.price),
        update: chosen(data.get("update_choice"), data.get("update_custom"), fallback.update),
      });
    };

    read();
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    form.addEventListener("reset", read);
    return () => {
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
      form.removeEventListener("reset", read);
    };
  }, [formId, priceMicro, updatePriceMicro]);

  const bps = BigInt(feeBps);
  const unsaved = live.price !== saved.price || live.update !== saved.update;
  const percent = `${Number(bps) / 100}%`;

  return (
    <div className="box">
      {unsaved ? (
        <p className="unsaved" role="status" data-status="warn">
          Not saved yet
        </p>
      ) : null}

      <h2>One release</h2>
      <Split gross={live.price} bps={bps} percent={percent} payer="Buyer pays" lead />

      <h2>A later release</h2>
      {live.update === 0n ? (
        <p className="written free">Free to anyone who already bought. Every later release is included in what they paid.</p>
      ) : (
        <Split gross={live.update} bps={bps} percent={percent} payer="Holder pays" />
      )}
    </div>
  );
}

/** One sale, itemised down to what the creator keeps. $0 gets a sentence, not a table. */
function Split({
  gross,
  bps,
  percent,
  payer,
  lead = false,
}: {
  gross: bigint;
  bps: bigint;
  percent: string;
  payer: string;
  lead?: boolean;
}) {
  if (gross === 0n) {
    return <p className="written free">Free to take. Nothing is charged and nothing is deducted.</p>;
  }
  const { feeMicro, netMicro } = splitFee(gross, bps);
  return (
    <dl className="cost-lines">
      <div className="cost">
        <dt className="written">{payer}</dt>
        <dd>{formatAmount(gross)}</dd>
      </div>
      <div className="cost fee">
        <dt className="written">Platform fee {percent}</dt>
        <dd>&minus;{formatAmount(feeMicro)}</dd>
      </div>
      <div className={lead ? "cost keep lead" : "cost keep"}>
        <dt className="written">You receive</dt>
        <dd>
          <strong>{formatAmount(netMicro)}</strong>
        </dd>
      </div>
    </dl>
  );
}

/**
 * The pricing route's `choose()`, read off a live form instead of a POST body: a preset
 * radio carries its own micro value, and `custom` sends the reader to the text field.
 * Falls back to the saved value while a half-typed amount is unparseable, so the box
 * holds still during "9" → "9." → "9.5" rather than flickering through an error.
 */
function chosen(choice: FormDataEntryValue | null, custom: FormDataEntryValue | null, fallback: bigint): bigint {
  const selected = String(choice ?? "").trim();
  if (selected !== "custom" && /^\d+$/.test(selected)) return BigInt(selected);
  try {
    return parsePriceInput(String(custom ?? ""));
  } catch {
    return fallback;
  }
}
