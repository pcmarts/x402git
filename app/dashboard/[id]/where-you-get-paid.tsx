/**
 * app/dashboard/[id]/where-you-get-paid.tsx — which rails this listing is sold on, and where
 * each one pays out (25 Oct 2026, HackMeridian).
 *
 * The founder, that evening: "The listing, we should give the user the option to switch
 * their payment address easily, right now, it just takes them to the wallet page, but we
 * should have the option to switch between." A creator can now hold two payout addresses,
 * an EVM `0x…` and a Stellar `G…`, and a listing was offered on every rail that reached one
 * of them: USDC on Base and USDT0 on Arbitrum land at the EVM address, USDT0 on Stellar at
 * the `G…`. This block is the switch. One row per rail this deployment runs, from
 * `payoutRailsFor` — the same function the 402 and `payment_options` read — with its chip,
 * the address a sale on it lands at, and an Offer box. Ticking is choosing among addresses
 * already bound; binding one is a signed act and stays on the wallet page, so a rail with
 * no wallet of its family yet is a disabled box and one link there.
 *
 * Inside the listing's one form, so the one Save carries it in the same PATCH as the
 * price. A table rather than a list: three facts per row that have to line up to be read
 * at a glance, and a column head is the visible "Offer" without a label per row. The
 * terse rule (founder, dashboard pages): no paragraph, one line under the rows.
 *
 * `offered_networks_shown` tells the save route the rows were on screen at all. A browser
 * posts nothing for an unticked box, so without it "every box unticked" and "a form from
 * before this block" would arrive as the same empty POST.
 *
 * Later that evening the right-hand box lost its "Paid to" address (founder: two places
 * saying where money lands is one too many), so these rows are now the only place on the
 * page that names an address, and a pending move ("Moving to … on …", the 48-hour
 * rebind) prints under the address it replaces, in every row of that family.
 */

import { RailChip } from "@/app/_components/rail-marks";
import { chainLabel } from "@/lib/buy-links";
import type { PayoutRail } from "@/lib/core/access";

/**
 * `0x7Ae2f4C1b93dE05a8814FbA9c0341eD6b27C5019` → `0x7Ae2…5019`.
 *
 * Not a secret — a payout address is public on-chain by construction — but a dashboard
 * is a thing people screenshot, and the whole string is of no use to its owner, who is
 * checking that it is the wallet they hold. The full value is one link away, on the page
 * that binds it. Moved here from page.tsx on 25 Oct 2026 so the payout box and the rows
 * below shorten an address the same way.
 */
export function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** A rail is ticked when it can pay this creator and the listing offers it: null offers everything. */
export function isOffered(rail: PayoutRail, offered: readonly string[] | null): boolean {
  return rail.address !== null && (offered === null || offered.includes(rail.network));
}

/** A queued rebind (only when the deployment runs a rebind delay), already shortened and formatted by the server. */
export type PendingMove = { address: string; at: string };

export function WhereYouGetPaid({
  rails,
  offered,
  pending = { evm: null, stellar: null },
}: {
  rails: PayoutRail[];
  offered: readonly string[] | null;
  pending?: { evm: PendingMove | null; stellar: PendingMove | null };
}) {
  return (
    <section id="get-paid">
      <h2>Where you get paid</h2>
      <input type="hidden" name="offered_networks_shown" value="1" />
      <table className="get-paid">
        <thead>
          <tr>
            <th scope="col">Way to pay</th>
            <th scope="col">Pays out to</th>
            <th scope="col">Offer</th>
          </tr>
        </thead>
        <tbody>
          {rails.map((rail) => {
            const id = `offer-${rail.network.replace(/[^a-z0-9]+/gi, "-")}`;
            const name = `${rail.symbol} on ${chainLabel(rail.network)}`;
            const move = pending[rail.family];
            return (
              <tr key={rail.network} data-network={rail.network}>
                <td>
                  <RailChip network={rail.network} symbol={rail.symbol} />
                </td>
                <td className="wrap">
                  {rail.address ? (
                    <>
                      <code>{shortAddress(rail.address)}</code>
                      {move ? (
                        <>
                          <br />
                          <small className="muted" data-status="warn">
                            Moving to {move.address} on {move.at}
                          </small>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="muted">No {rail.family === "evm" ? "EVM" : "Stellar"} wallet yet</span>
                      {" · "}
                      <a href="/dashboard/wallet">Add on the wallet page</a>
                    </>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    id={id}
                    name="offered_networks[]"
                    value={rail.network}
                    defaultChecked={isOffered(rail, offered)}
                    disabled={rail.address === null}
                    aria-label={`Offer ${name}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="written note">
        <small className="muted">
          Buyers see only the offered ways to pay. Addresses change on <a href="/dashboard/wallet">the wallet page</a>.
        </small>
      </p>
    </section>
  );
}
