/**
 * lib/events.test.ts — the three §10 event names that are also admin alerts, and the two
 * promises `record` makes to everything that calls it: it never fails a paid request, and
 * nothing identifying leaves with the alert.
 *
 * "PRD Trust Report.md" §7 puts the alerts on event names rather than on the scanners, so
 * this is where they are tested: `lib/scan/**` writes the event and knows nothing about a
 * phone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { notifyAdmin } from "@/lib/notify";
import { makeMockDb } from "@/lib/test/mock-db";
import { record } from "./events";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  vi.mocked(notifyAdmin).mockClear();
});

afterEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

describe("record — the admin alerts (\"PRD Trust Report.md\" §7)", () => {
  it("shouts about a release whose dependencies now carry a malware record", async () => {
    await record({
      name: "release_compromised",
      listingId: "l1",
      props: { version: "1.2.0", release_id: "r1", package: "left-pad@1.0.0", source: "osv" },
    });

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith({
      kind: "error",
      where: "release_compromised",
      code: "release_compromised",
      severity: "error",
      message: "A passing release's dependencies now carry a malware record — FR-39 is the path that acts",
      listingId: "l1",
      details: { version: "1.2.0", release_id: "r1", package: "left-pad@1.0.0", source: "osv" },
    });
    // The row is still written: the alert is a copy, never a replacement (§10).
    expect(mock.rows("event")).toHaveLength(1);
  });

  it("shouts about a rotated Socket token and murmurs about its quota", async () => {
    await record({ name: "release_scan_socket_auth", props: { status: 401 } });
    await record({ name: "release_scan_socket_quota", props: { status: 429, floor: true } });

    expect(vi.mocked(notifyAdmin).mock.calls[0][0]).toMatchObject({
      severity: "error",
      code: "release_scan_socket_auth",
      message: "Socket answered 401 — token probably rotated",
      listingId: null,
      details: { status: 401 },
    });
    expect(vi.mocked(notifyAdmin).mock.calls[1][0]).toMatchObject({
      severity: "alert",
      code: "release_scan_socket_quota",
      message: "Socket answered 403/429 or the 10% floor stopped the call",
      details: { status: 429, floor: true },
    });
  });

  it("says nothing about an ordinary event — a settlement is not an alert", async () => {
    await record({ name: "settled", listingId: "l1", buyerAddress: "0x00000000000000000000000000000000000000a1", source: "api" });
    await record({ name: "download", listingId: "l1" });
    // A `review`-tier finding is shown on /admin/activity and is deliberately not a buzz.
    await record({ name: "release_scan_review", props: { alert: "unsafeRegex" } });

    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it("drops anything address-shaped, and anything that is not a scalar, from the details", async () => {
    await record({
      name: "release_compromised",
      buyerAddress: "0x00000000000000000000000000000000000000a1",
      props: {
        version: "1.2.0",
        // FR-40 and the Telegram channel: an address never travels, whatever it is called.
        buyer_address: "0x00000000000000000000000000000000000000a1",
        payout_address: "0x00000000000000000000000000000000000000B2",
        // A notification is one line per fact; a whole report is not one.
        report: { checks: [{ id: "osv" }] },
        packages: ["left-pad"],
        blocked: true,
        count: 3,
      },
    });

    const [event] = vi.mocked(notifyAdmin).mock.calls[0];
    expect(event.kind === "error" && event.details).toEqual({ version: "1.2.0", blocked: true, count: 3 });
    expect(JSON.stringify(event).toLowerCase()).not.toContain("0x00000000000000000000000000000000000000a1");
    expect(JSON.stringify(event).toLowerCase()).not.toContain("0x00000000000000000000000000000000000000b2");
  });

  it("still alerts when the insert itself failed — that is when it matters most", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setDb({
      from() {
        throw new Error("database is down");
      },
    } as unknown as Db);

    await expect(record({ name: "release_scan_socket_auth", props: { status: 401 } })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("record — the rail (migration 20261025090100)", () => {
  it("stamps network and the EVM chain id when no network is named, as every event was", async () => {
    await record({ name: "402_issued", listingId: "l1" });
    expect(mock.rows("event")[0]).toMatchObject({ network: "eip155:84532", chain_id: 84532 });
  });

  it("stamps a Stellar event with its network, a null chain_id, and the buyer's strkey intact", async () => {
    const G = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
    await record({ name: "settled", listingId: "l1", buyerAddress: G, network: "stellar:testnet" });
    expect(mock.rows("event")[0]).toMatchObject({ network: "stellar:testnet", chain_id: null, buyer_address: G });
    // An EVM buyer is still stored lower-case.
    await record({ name: "settled", listingId: "l1", buyerAddress: "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa" });
    expect(mock.rows("event")[1].buyer_address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("drops a Stellar address from an alert's details the way it drops an EVM one (FR-40)", async () => {
    await record({ name: "release_compromised", listingId: "l1", props: { version: "1.0.0", wallet: "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57" } });
    const event = vi.mocked(notifyAdmin).mock.calls[0][0];
    expect(JSON.stringify(event)).not.toContain("GDVEU3DD");
  });
});
