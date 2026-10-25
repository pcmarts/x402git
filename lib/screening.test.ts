import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { OFAC_ETH_LIST_URL, PROVIDER, resetScreeningCache, screen } from "./screening";

const SANCTIONED = "0x7f367cc41522ce07553e823bf3be79a889debe1b";
const CLEAN = "0x1234567890abcdef1234567890abcdef12345678";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
});
afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
});

function stubList(addresses: string[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(addresses), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("screen (FR-38)", () => {
  it("flags an address on the OFAC list", async () => {
    stubList([SANCTIONED]);
    const result = await screen(SANCTIONED, "bind");
    expect(result.hit).toBe(true);
    expect(result.provider).toBe(PROVIDER);
  });

  it("passes an address that is not on it", async () => {
    stubList([SANCTIONED]);
    expect((await screen(CLEAN, "settle")).hit).toBe(false);
  });

  it("matches regardless of case", async () => {
    stubList([SANCTIONED.toUpperCase()]);
    expect((await screen(SANCTIONED, "sweep")).hit).toBe(true);
  });

  it("writes a screening row every time, hit or not (5-year retention)", async () => {
    stubList([SANCTIONED]);
    await screen(SANCTIONED, "bind");
    await screen(CLEAN, "sweep");

    const rows = mock.rows("screening");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ address: SANCTIONED, context: "bind", hit: true, provider: PROVIDER });
    expect(rows[1]).toMatchObject({ address: CLEAN, context: "sweep", hit: false });
  });

  it("fetches the list once and caches it for 24 hours", async () => {
    const fetchMock = stubList([SANCTIONED]);
    await screen(CLEAN, "bind");
    await screen(CLEAN, "bind");
    await screen(SANCTIONED, "settle");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(OFAC_ETH_LIST_URL, expect.anything());
  });

  it("fails open with hit=false and raw.error when the list cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    const result = await screen(SANCTIONED, "settle");
    expect(result.hit).toBe(false);
    expect(result.degraded).toBe(true);

    const raw = mock.rows("screening")[0].raw as { error?: string };
    expect(raw.error).toBeTruthy();
  });

  it("fails open when the list is not an array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ addresses: [] }), { status: 200 })));
    const result = await screen(SANCTIONED, "bind");
    expect(result.hit).toBe(false);
    expect(result.degraded).toBe(true);
  });
});
