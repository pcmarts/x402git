/**
 * lib/mcp/server.test.ts — FR-31, over a real MCP client.
 *
 * The tools are exercised through `Client` and a linked in-memory transport rather than
 * by calling the callbacks directly, because half of what FR-31 asks for is the
 * *protocol* surface: the six names, the "wraps" line in each description, the input
 * schemas, and whether an unpaid `purchase` arrives shaped as the x402 MCP transport
 * spec demands — `isError: true`, `PaymentRequired` as structured content, the
 * `_meta` mirrors a real paying client detects.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { setPublicGithub } from "@/lib/github/public";
import { resetPromiseCache } from "@/lib/release/promise";
import { resetScreeningCache } from "@/lib/screening";
import { stubPublicGithub } from "@/lib/test/public-github";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_CREATOR } from "@/lib/test/stellar";
import { nonceHex, paymentPayload, signatureHeader, stubFacilitator } from "@/lib/test/x402";
import { resetFacilitator, setFacilitator } from "@/lib/x402/server";
import { buildMcpServer, TOOL_NAMES } from "./server";
import { MCP_TOOL_DOCS } from "./tool-docs";

const BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const buyer = privateKeyToAccount(BUYER_KEY);
const OTHER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const other = privateKeyToAccount(OTHER_KEY);
const PAY_TO = "0x1111111111111111111111111111111111111111";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  // FR-38 screening reads the OFAC list over the network; a test never does.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = PAY_TO;
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetFacilitator();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

/**
 * A connected client speaking to a fresh server over a linked in-memory pair. `geo` is
 * the FR-38 country the platform edge would have annotated the HTTP request with; the
 * server carries it into `purchaseFlow` exactly as `/api/mcp` does.
 */
async function connect(geo?: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const req = geo ? new Request("https://x402git.test/api/mcp", { headers: { "x-vercel-ip-country": geo } }) : undefined;
  await Promise.all([client.connect(clientSide), buildMcpServer(req).connect(serverSide)]);
  return client;
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, any>;
  content?: { type: string; text?: string }[];
  _meta?: Record<string, any>;
};

/** Error results carry the §9 body as JSON text only (no `structuredContent`). */
function errorBody(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** FR-20: `<address>.<nonce>.<eip191_sig>` over a fresh challenge. */
async function walletSignature(account = buyer): Promise<string> {
  const challenge = await issueChallenge(account.address, "wallet_ownership");
  const signature = await account.signMessage({ message: challenge.message });
  return `${account.address}.${challenge.nonce}.${signature}`;
}

function pay(amountMicro: bigint, nonce: string, from = buyer.address) {
  return signatureHeader({ from, amountMicro, nonce, payTo: PAY_TO });
}

describe("the tool catalogue (FR-31)", () => {
  it("advertises exactly the six buy-side tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("is the list the /docs page prints, in the same order", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(MCP_TOOL_DOCS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    // A tool the docs say wraps a route says so in its own description too.
    for (const doc of MCP_TOOL_DOCS) {
      const description = tools.find((t) => t.name === doc.name)?.description ?? "";
      if (doc.wraps) expect(description).toContain(`Wraps \`GET ${doc.wraps}\``);
      else expect(description).not.toContain("Wraps `");
    }
  });

  it("documents each tool as wrapping its route", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const wraps = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));

    expect(wraps.get_listing).toContain("Wraps `GET /api/label/:owner/:slug`");
    expect(wraps.check_version).toContain("Wraps `GET /api/v/:owner/:slug`");
    expect(wraps.purchase).toContain("Wraps `GET /api/r/:owner/:slug`");
    expect(wraps.fetch_release).toContain("Wraps `GET /api/r/:owner/:slug/v/:version`");
  });

  it("takes a pre-signed authorization on purchase and requires a wallet on fetch_release", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName.purchase.inputSchema.properties ?? {})).toContain("payment_signature");
    expect(byName.purchase.inputSchema.required ?? []).not.toContain("payment_signature");
    expect(byName.fetch_release.inputSchema.required ?? []).toContain("wallet_signature");
  });
});

/**
 * The `computed` block the analyser writes onto the release row. The shared fixture
 * seeds a placeholder, because most money tests never read the manifest; `get_listing`
 * is the one that does.
 */
function withManifest(version: string) {
  const release = mock.rows("release").find((r) => r.version === version);
  if (!release) throw new Error(`no release ${version}`);
  release.manifest = {
    computed: {
      artifact_class: "Harness",
      component_inventory: [{ kind: "skill", count: 1 }],
      file_count: 18,
      dir_depth: 3,
      bytes_text: 225_280,
      bytes_binary: 67_584,
      languages: { Python: 68_000 },
      tree: [{ path: "README.md", size: 4_096, binary: false }],
      readme_html: "<p>hello</p>",
      dependencies: [{ name: "requests", ecosystem: "pypi", version: "2.31.0" }],
      licence: { spdx: "MIT", verdict: "pass" },
      scan: { verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00.000Z" },
      computed_at: "2026-08-28T16:20:00.000Z",
      analyzer_version: "0.1.0",
    },
  };
}

/** A passing release's stored manifest, with the computed fields search reads. */
function withSearchManifest(slug: string, computed: Record<string, unknown>) {
  const listing = mock.rows("listing").find((l) => l.slug === slug);
  const release = mock.rows("release").find((r) => r.listing_id === listing?.id);
  if (!release) throw new Error(`no release for ${slug}`);
  release.manifest = { computed };
}

describe("search_listings — find a listing without knowing its name (NG1 amended 16 Sep 2026)", () => {
  function seedCatalogue() {
    seedListing(mock, { owner: "adrian", slug: "humanizer", releases: [{ version: "1.0.2" }] });
    withSearchManifest("humanizer", {
      artifact_class: "Toolkit",
      component_inventory: [{ kind: "skills", count: 1 }],
      languages: { JavaScript: 10_000 },
      inventory_sentence: "1 skill · 1 script",
      readme_html: "<p>A script and a skill for taking the machine sound out of a draft.</p>",
    });

    seedListing(mock, { owner: "paul", slug: "changelog-writer", priceMicro: "4000000", releases: [{ version: "2.0.0" }] });
    const changelog = mock.rows("listing").find((l) => l.slug === "changelog-writer")!;
    changelog.description = "Writes release notes from git history.";
    changelog.trigger_hint = "when you tag a release";
    withSearchManifest("changelog-writer", {
      artifact_class: "Prompt",
      component_inventory: [{ kind: "prompts", count: 2 }],
      languages: {},
      readme_html: "<p>Reads the commits since the last tag and drafts a changelog. Also removes the machine sound.</p>",
    });
  }

  it("finds a listing by what it does, with every field the next call needs", async () => {
    seedCatalogue();
    const client = await connect();

    const result = await call(client, "search_listings", { query: "release notes from git" });
    expect(result.isError).toBe(false);
    const data = result.structuredContent!;
    expect(data.total).toBe(1);
    expect(data.results[0]).toMatchObject({
      owner: "paul",
      slug: "changelog-writer",
      description: "Writes release notes from git history.",
      latest: "2.0.0",
      price_micro: "4000000",
      price_usd: "$4",
      artifact_class: "Prompt",
      tags: ["prompt", "prompts"],
      matched: ["release", "notes", "git"],
      listing_url: "https://x402git.test/paul/changelog-writer",
      manifest_url: "https://x402git.test/api/label/paul/changelog-writer",
    });
  });

  it("matches computed tags, so `skill` finds the listing with a skill in it", async () => {
    seedCatalogue();
    const client = await connect();
    const { structuredContent } = await call(client, "search_listings", { query: "skill" });
    expect(structuredContent!.results.map((r: { slug: string }) => r.slug)).toEqual(["humanizer"]);
  });

  it("orders by where the words matched — the name above a README mention — not by anything else", async () => {
    seedCatalogue();
    const client = await connect();
    // Both READMEs say "machine sound"; only one is called humanizer.
    const { structuredContent } = await call(client, "search_listings", { query: "humanizer machine sound" });
    expect(structuredContent!.results.map((r: { slug: string }) => r.slug)).toEqual(["humanizer", "changelog-writer"]);
  });

  it("lists every live listing for an empty query, and honours the price ceiling and the limit", async () => {
    seedCatalogue();
    const client = await connect();

    const all = await call(client, "search_listings", {});
    expect(all.structuredContent!.total).toBe(2);

    const cheap = await call(client, "search_listings", { max_price_micro: "5000000" });
    expect(cheap.structuredContent!.results.map((r: { slug: string }) => r.slug)).toEqual(["changelog-writer"]);

    const one = await call(client, "search_listings", { limit: 1 });
    expect(one.structuredContent!.total).toBe(2);
    expect(one.structuredContent!.results).toHaveLength(1);
  });

  it("never returns what cannot be bought: drafts, retired listings, or no passing release", async () => {
    seedListing(mock, { owner: "a", slug: "draft-skill", published: false });
    seedListing(mock, { owner: "b", slug: "retired-skill", retired: true });
    seedListing(mock, { owner: "c", slug: "failed-skill", releases: [{ version: "1.0.0", scan: "fail" }] });
    const client = await connect();

    const { structuredContent } = await call(client, "search_listings", { query: "skill" });
    expect(structuredContent).toEqual({ query: "skill", total: 0, results: [] });
  });

  it("needs no wallet and is listed first", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools[0].name).toBe("search_listings");
    expect(tools[0].inputSchema.required ?? []).toEqual([]);
    expect(tools[0].description).toContain("never by sales or popularity");
  });
});

describe("how_to_buy — the tool for the client that cannot sign (2026-09-02)", () => {
  it("returns the price and every URL a referral needs, with no wallet", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const client = await connect();

    const result = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      owner: "adrian",
      slug: "humanizer",
      status: "live",
      for_sale: true,
      latest: "1.2.0",
      price_micro: "9000000",
      update_price_micro: "3000000",
      listing_url: "https://x402git.test/adrian/humanizer",
      manifest_url: "https://x402git.test/api/label/adrian/humanizer",
      skill_url: "https://x402git.test/.well-known/agent-skills/buy-a-repo/SKILL.md",
      resource_endpoint: "https://x402git.test/api/r/adrian/humanizer",
      mcp_url: "https://x402git.test/api/mcp",
    });

    // The two paragraphs name the URLs they are about, so a model can quote them.
    const { with_a_wallet, without_a_wallet, price_usd } = result.structuredContent!;
    expect(with_a_wallet).toContain("https://x402git.test/.well-known/agent-skills/buy-a-repo/SKILL.md");
    expect(with_a_wallet).toContain("PAYMENT-SIGNATURE");
    expect(without_a_wallet).toContain("https://x402git.test/adrian/humanizer");
    expect(without_a_wallet).toContain(price_usd);
    // The chain in the prose is the chain the test environment pays on, not "Base".
    expect(with_a_wallet).toContain("on Base Sepolia");
    expect(without_a_wallet).toContain("USDC on Base Sepolia");
  });

  it("does not refer anyone to a retired listing", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }], retired: true });
    const client = await connect();
    const result = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" });
    expect(result.isError).toBe(false);
    const data = result.structuredContent!;
    expect(data.status).toBe("retired");
    expect(data.for_sale).toBe(false);
    expect(data.with_a_wallet).toContain("Not for sale");
    expect(data.without_a_wallet).toContain("no longer sold");
    expect(data.without_a_wallet).not.toContain("buy it themselves");
  });

  it("does not quote a procedure for a listing with no passing release", async () => {
    seedListing(mock, { releases: [] });
    const client = await connect();
    const result = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" });
    expect(result.isError).toBe(false);
    const data = result.structuredContent!;
    expect(data.status).toBe("live");
    expect(data.latest).toBeNull();
    expect(data.for_sale).toBe(false);
    expect(data.with_a_wallet).toContain("no_release");
    expect(data.without_a_wallet).toContain("cannot be bought today");
    expect(data.with_a_wallet).not.toContain("PAYMENT-SIGNATURE");
  });

  it("is a 404 for a listing that does not exist, like every other tool", async () => {
    const client = await connect();
    const result = await call(client, "how_to_buy", { owner: "nobody", slug: "nothing" });
    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("not_found");
  });

  it("is listed straight after search, before anything that needs a wallet, and tells a client without one what to do", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).slice(0, 2)).toEqual(["search_listings", "how_to_buy"]);
    expect(tools[1].description).toContain("without_a_wallet");
    expect(tools[1].inputSchema.required ?? []).not.toContain("wallet_signature");
  });
});

describe("get_listing — wraps GET /api/label", () => {
  it("returns the manifest of the latest passing release", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    withManifest("1.2.0");
    const client = await connect();

    const result = await call(client, "get_listing", { owner: "adrian", slug: "humanizer" });

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.version).toBe("1.2.0");
    expect(result.structuredContent?.owner).toBe("adrian");
    expect(result.structuredContent?.status).toBe("live");
    expect(result.structuredContent?.manifest_url).toBe("https://x402git.test/api/label/adrian/humanizer");
  });

  it("is not_found for a draft, like the route", async () => {
    seedListing(mock, { published: false });
    const client = await connect();

    const result = await call(client, "get_listing", { owner: "adrian", slug: "humanizer" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(errorBody(result).code).toBe("not_found");
  });
});

describe("check_version — quote serialised", () => {
  it("answers version data with no wallet and never reveals what an address owns", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const client = await connect();

    const result = await call(client, "check_version", { owner: "adrian", slug: "humanizer" });

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.latest).toBe("1.2.0");
    expect(result.structuredContent?.price_micro).toBe("9000000");
    expect(result.structuredContent?.owned).toBeUndefined();
    expect(result.structuredContent?.entitled).toBeUndefined();
  });

  it("prices the update for a holder when the wallet is proved (FR-16)", async () => {
    const seeded = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, { listingId: seeded.listingId, releaseId: seeded.releases[0].id, buyer: buyer.address });
    const client = await connect();

    const result = await call(client, "check_version", {
      owner: "adrian",
      slug: "humanizer",
      wallet_signature: await walletSignature(),
    });

    expect(result.structuredContent?.owned).toBe("1.0.0");
    expect(result.structuredContent?.entitled).toBe(false);
    expect(result.structuredContent?.price_kind).toBe("update");
    expect(result.structuredContent?.price_micro).toBe("3000000");
  });
});

describe("check_version — a draft is not a public resource", () => {
  it("is not_found for a draft, the same rule /api/v applies", async () => {
    seedListing(mock, { published: false, releases: [{ version: "1.0.0" }] });
    const client = await connect();

    const result = await call(client, "check_version", { owner: "adrian", slug: "humanizer" });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("not_found");
    expect(result.content?.[0]?.text ?? "").not.toContain("9000000");
  });
});

describe("purchase — the same three calls as GET /api/r", () => {
  it("returns the 402 per the x402 MCP transport: isError, PaymentRequired, _meta mirror", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const client = await connect();

    const result = await call(client, "purchase", { owner: "adrian", slug: "humanizer" });

    // `isError: true` is how the transport spec — and every client written to it —
    // signals a paid tool. The 402 is still the price, not a failure; the tool
    // description carries that reading.
    expect(result.isError).toBe(true);
    const body = result.structuredContent!;
    expect(body.x402Version).toBe(2);
    expect(body.error).toContain("Payment required");
    expect(body.accepts[0].maxAmountRequired).toBe("9000000");
    expect(body.accepts[0].payTo).toBe(PAY_TO);
    expect(body.extra.kind).toBe("new");
    expect(body.extra.quote_id).toBeTruthy();
    // The same JSON travels as text for clients without structured content…
    expect(JSON.parse(result.content?.[0]?.text ?? "")).toEqual(body);
    // …and mirrored in `_meta["x402/error"]`, the field `withX402Client` detects.
    expect(result._meta?.["x402/error"]).toEqual(body);
    expect(mock.rows("purchase")).toHaveLength(0);
    expect(mock.rows("event").map((e) => e.name)).toContain("402_issued");
  });

  it("settles a signed authorization and records the purchase as source mcp", async () => {
    const seeded = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);
    const client = await connect();

    // W1.3: a priced buy must echo the quote_id from the 402 it is paying against.
    const quoted = await call(client, "purchase", { owner: "adrian", slug: "humanizer" });
    const result = await call(client, "purchase", {
      owner: "adrian",
      slug: "humanizer",
      payment_signature: pay(9_000_000n, nonceHex("a1")),
      wallet_signature: await walletSignature(),
      quote_id: quoted.structuredContent?.extra?.quote_id,
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe("granted");
    expect(result.structuredContent?.version).toBe("1.2.0");
    expect(result.structuredContent?.artifact_sha256).toBe(seeded.latest.artifactSha256);
    expect(result.structuredContent?.download_url).toContain(seeded.latest.storagePath);
    expect(Date.parse(result.structuredContent?.expires_at)).toBeGreaterThan(Date.now());
    // The transport spec's settlement confirmation, the twin of `PAYMENT-RESPONSE`.
    expect(result._meta?.["x402/payment-response"]?.success).toBe(true);
    expect(result._meta?.["x402/payment-response"]?.transaction).toBeTruthy();

    const rows = mock.rows("purchase");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("mcp");
    expect(rows[0].tx_hash).toBeTruthy();
    expect(mock.rows("event").find((e) => e.name === "settled")?.source).toBe("mcp");
  });

  it("refuses when the payer is not the wallet that signed (FR-20)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);
    const client = await connect();

    const result = await call(client, "purchase", {
      owner: "adrian",
      slug: "humanizer",
      // Signed by `buyer`, paid by `other`.
      payment_signature: pay(9_000_000n, nonceHex("b2"), other.address),
      wallet_signature: await walletSignature(),
    });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("authorization_mismatch");
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("grants nothing when settle returns no transaction hash (FR-22)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator({ settle: { success: true, transaction: "", network: "eip155:84532" } });
    setFacilitator(facilitator.client);
    const client = await connect();

    const quoted = await call(client, "purchase", { owner: "adrian", slug: "humanizer" });
    const result = await call(client, "purchase", {
      owner: "adrian",
      slug: "humanizer",
      payment_signature: pay(9_000_000n, nonceHex("c3")),
      quote_id: quoted.structuredContent?.extra?.quote_id,
    });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("settlement_pending");
    expect(errorBody(result).details.payment_required.x402Version).toBe(2);
    // No `_meta["x402/error"]` on a payment error: the money may already have moved,
    // and a spec client seeing fresh requirements would sign a second authorization.
    expect(result._meta?.["x402/error"]).toBeUndefined();
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("is 451 from a comprehensively sanctioned jurisdiction, like the route (FR-38)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);
    const client = await connect("IR");

    const result = await call(client, "purchase", {
      owner: "adrian",
      slug: "humanizer",
      payment_signature: pay(9_000_000n, nonceHex("beef")),
    });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("blocked_jurisdiction");
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);

    // The tool is unaffected everywhere else, and a server with no geo never blocks.
    expect((await call(await connect("GB"), "purchase", { owner: "adrian", slug: "humanizer" })).structuredContent?.x402Version).toBe(2);
    expect((await call(await connect(), "purchase", { owner: "adrian", slug: "humanizer" })).structuredContent?.x402Version).toBe(2);
  });

  it("answers a replayed authorization only to the wallet that bought it", async () => {
    const seeded = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const nonce = nonceHex("dd");
    seedPurchase(mock, {
      listingId: seeded.listingId,
      releaseId: seeded.latest.id,
      buyer: "0x9999999999999999999999999999999999999999",
      nonce,
    });
    const client = await connect();

    const result = await call(client, "purchase", {
      owner: "adrian",
      slug: "humanizer",
      payment_signature: pay(9_000_000n, nonce),
      wallet_signature: await walletSignature(),
    });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("authorization_mismatch");
  });

  it("hands a $0 listing over with no payment at all (FR-24)", async () => {
    seedListing(mock, { priceMicro: "0", updatePriceMicro: "0", releases: [{ version: "1.0.0" }] });
    const client = await connect();

    const result = await call(client, "purchase", { owner: "adrian", slug: "humanizer", wallet_signature: await walletSignature() });

    expect(result.structuredContent?.status).toBe("granted");
    expect(mock.rows("purchase")[0].source).toBe("mcp");
  });
});

describe("purchase — the x402 MCP transport payment paths", () => {
  it('accepts the Cloudflare client\'s base64 token in _meta["x402/payment"]', async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);
    const client = await connect();

    // W1.3: a priced buy must echo quote_id even when paying via the _meta transport.
    const quoted = (await client.callTool({ name: "purchase", arguments: { owner: "adrian", slug: "humanizer" } })) as ToolResult;
    const result = (await client.callTool({
      name: "purchase",
      arguments: { owner: "adrian", slug: "humanizer", quote_id: quoted.structuredContent?.extra?.quote_id },
      _meta: { "x402/payment": pay(9_000_000n, nonceHex("e4")) },
    })) as ToolResult;

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe("granted");
    expect(result._meta?.["x402/payment-response"]?.success).toBe(true);
    expect(mock.rows("purchase")[0]?.source).toBe("mcp");
  });

  it('accepts the spec\'s PaymentPayload object in _meta["x402/payment"]', async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);
    const client = await connect();

    const quoted = (await client.callTool({ name: "purchase", arguments: { owner: "adrian", slug: "humanizer" } })) as ToolResult;
    const result = (await client.callTool({
      name: "purchase",
      arguments: { owner: "adrian", slug: "humanizer", quote_id: quoted.structuredContent?.extra?.quote_id },
      _meta: { "x402/payment": paymentPayload({ from: buyer.address, amountMicro: 9_000_000n, nonce: nonceHex("e5"), payTo: PAY_TO }) },
    })) as ToolResult;

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe("granted");
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("the payment_signature argument wins over _meta, and garbage _meta is just the 402", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);
    const client = await connect();

    const quoted = (await client.callTool({ name: "purchase", arguments: { owner: "adrian", slug: "humanizer" } })) as ToolResult;
    const result = (await client.callTool({
      name: "purchase",
      arguments: { owner: "adrian", slug: "humanizer", payment_signature: pay(9_000_000n, nonceHex("e6")), quote_id: quoted.structuredContent?.extra?.quote_id },
      _meta: { "x402/payment": "not-a-payment" },
    })) as ToolResult;
    expect(result.structuredContent?.status).toBe("granted");

    const garbage = (await client.callTool({
      name: "purchase",
      arguments: { owner: "adrian", slug: "humanizer" },
      _meta: { "x402/payment": 42 },
    })) as ToolResult;
    expect(garbage.isError).toBe(true);
    expect(garbage.structuredContent?.x402Version).toBe(2);
  });

  it("survives a schema-caching client: listTools first, then the unpaid 402", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const client = await connect();

    const { tools } = await client.listTools();
    const purchase = tools.find((t) => t.name === "purchase");
    // Pre-advertised as paid (the Agents SDK extension) and deliberately without an
    // outputSchema — a cached validator would reject every 402 client-side.
    expect(purchase?._meta?.["agents-x402/paymentRequired"]).toBe(true);
    expect(purchase?.outputSchema).toBeUndefined();

    // With validators cached from listTools, neither the 402 nor a §9 error throws.
    const unpaid = await call(client, "purchase", { owner: "adrian", slug: "humanizer" });
    expect(unpaid.isError).toBe(true);
    expect((unpaid.structuredContent as any).accepts).toHaveLength(1);
    const missing = await call(client, "get_listing", { owner: "nobody", slug: "nothing" });
    expect(errorBody(missing).code).toBe("not_found");
  });
});

describe("fetch_release — wraps the version endpoint", () => {
  it("re-issues a download URL for a version this wallet owns", async () => {
    const seeded = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, { listingId: seeded.listingId, releaseId: seeded.releases[0].id, buyer: buyer.address });
    const client = await connect();

    const result = await call(client, "fetch_release", {
      owner: "adrian",
      slug: "humanizer",
      version: "1.0.0",
      wallet_signature: await walletSignature(),
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.version).toBe("1.0.0");
    expect(result.structuredContent?.artifact_sha256).toBe(seeded.releases[0].artifactSha256);
    expect(mock.rows("event").find((e) => e.name === "download")?.source).toBe("mcp");
  });

  it("requires the wallet signature — there is no ?address= oracle", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const client = await connect();

    // The schema itself refuses the call; the SDK reports it as a tool error.
    const result = await call(client, "fetch_release", { owner: "adrian", slug: "humanizer", version: "1.0.0" });
    expect(result.isError).toBe(true);
  });

  it("is not_entitled for a version this wallet never bought", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const client = await connect();

    const result = await call(client, "fetch_release", {
      owner: "adrian",
      slug: "humanizer",
      version: "1.0.0",
      wallet_signature: await walletSignature(),
    });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("not_entitled");
  });
});

describe("payment_options — which networks a listing takes, on every free tool (JOURNEYS B4a, 25 Oct 2026)", () => {
  afterEach(() => {
    clearStellarEnv();
    resetEnv();
  });

  it("puts the Base option on search results, the manifest and how_to_buy for an EVM creator", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    withManifest("1.2.0");
    const client = await connect();

    // The manifest first, while the full manifest is in place.
    const listing = await call(client, "get_listing", { owner: "adrian", slug: "humanizer" });
    expect(listing.isError).toBe(false);
    const options = listing.structuredContent!.payment_options;
    expect(options).toEqual([expect.objectContaining({ network: "eip155:84532", asset_symbol: "USDC", amount: "9000000" })]);
    expect(options[0].how).not.toContain("accepts[0]");

    // Then the search, over the slimmer computed block the search reads.
    withSearchManifest("humanizer", { artifact_class: "Toolkit", component_inventory: [{ kind: "skills", count: 1 }], languages: {}, readme_html: "<p>Takes the machine sound out of a draft.</p>" });
    const search = await call(client, "search_listings", { query: "humanizer" });
    const row = search.structuredContent!.results[0];
    expect(row.payment_options).toEqual(options);

    const how = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" });
    expect(how.structuredContent!.payment_options).toEqual(options);
    expect(how.structuredContent!.cannot_pay).toBeUndefined();
    expect(how.structuredContent!.with_a_wallet).not.toContain("accepts[0]");
    expect(how.structuredContent!.with_a_wallet).toContain("entry whose `network` is yours");
  });

  it("answers cannot_pay with the options that exist when the caller's network is not offered", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const client = await connect();

    const result = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer", network: "stellar:pubnet" });
    expect(result.isError).toBe(false);
    const body = result.structuredContent!;
    expect(body.cannot_pay).toBe(true);
    expect(body.for_sale).toBe(true);
    expect(body.payment_options).toEqual([expect.objectContaining({ network: "eip155:84532" })]);
    expect(body.with_a_wallet).toContain("You cannot pay");
    expect(body.with_a_wallet).toContain("USDC on Base Sepolia");
    expect(body.with_a_wallet).toContain("Do not sign anything");
    expect(body.without_a_wallet).toContain("USDC on Base Sepolia");

    // Naming a network the listing does take keeps the ordinary shape.
    const ok = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer", network: "eip155:84532,stellar:pubnet" });
    expect(ok.structuredContent!.cannot_pay).toBeUndefined();
    expect(ok.structuredContent!.with_a_wallet).toContain("PAYMENT-SIGNATURE");
  });

  it("offers Stellar alone, with the CLI line, for a creator whose only address is a Stellar account", async () => {
    setStellarTestnetEnv();
    resetEnv();
    seedListing(mock, { payoutAddress: STELLAR_CREATOR, releases: [{ version: "1.2.0" }] });
    withSearchManifest("humanizer", { artifact_class: "Toolkit", component_inventory: [{ kind: "skills", count: 1 }], languages: {}, readme_html: "<p>Takes the machine sound out of a draft.</p>" });
    const client = await connect();

    const how = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" });
    const body = how.structuredContent!;
    expect(body.payment_options).toEqual([expect.objectContaining({ network: "stellar:testnet", asset_symbol: "USDC", amount: "90000000" })]);
    expect(body.with_a_wallet).toContain("npx x402git-stellar buy adrian/humanizer");
    expect(body.with_a_wallet).not.toContain("EIP-3009");
    expect(body.without_a_wallet).toContain("USDC on Stellar testnet");
    expect(body.without_a_wallet).toContain("npx x402git-stellar buy adrian/humanizer");

    const refused = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer", network: "eip155:8453" });
    expect(refused.structuredContent!.cannot_pay).toBe(true);
    expect(refused.structuredContent!.with_a_wallet).toContain("USDC on Stellar testnet");

    const search = await call(client, "search_listings", {});
    expect(search.structuredContent!.results[0].payment_options.map((o: { network: string }) => o.network)).toEqual(["stellar:testnet"]);
  });

  it("says nothing of accepts[0] or micro-USDC anywhere an agent reads", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const text = JSON.stringify(tools);
    expect(text).not.toContain("accepts[0]");
    expect(text).not.toMatch(/micro-USDC/i);
    expect(text).not.toContain("holding USDC on");
  });
});

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian): the promise an agent reads
// ---------------------------------------------------------------------------

describe("open_release in get_listing and how_to_buy (STRATEGY Proof 4: an agent can see it too)", () => {
  const PUBLIC = "https://github.com/adrian/humanizer-public";
  const COMMIT = "0".repeat(40); // what the shared fixture stamps on every release

  function seedOpen(release: Record<string, unknown>) {
    const seeded = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    withManifest("1.2.0");
    Object.assign(mock.rows("listing").find((l) => l.id === seeded.listingId)!, { open_release: true, public_repo_url: PUBLIC, next_opens_at: "2026-12-01T00:00:00.000Z" });
    Object.assign(mock.rows("release").find((r) => r.id === seeded.latest.id)!, {
      opens_at: "2026-12-01T00:00:00.000Z",
      open_licence_spdx: "MIT",
      promise_status: "pending",
      open_eligibility: [{ id: "licence", ok: true, detail: "MIT permits resale." }],
      ...release,
    });
    return seeded;
  }

  afterEach(() => {
    setPublicGithub(null);
    resetPromiseCache();
  });

  it("is null on an ordinary listing", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    withManifest("1.2.0");
    const client = await connect();
    expect((await call(client, "get_listing", { owner: "adrian", slug: "humanizer" })).structuredContent?.open_release).toBeNull();
    expect((await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" })).structuredContent?.open_release).toBeNull();
  });

  it("carries the same block in both tools, read off the stored columns", async () => {
    seedOpen({});
    const client = await connect();

    const listing = await call(client, "get_listing", { owner: "adrian", slug: "humanizer" });
    const buy = await call(client, "how_to_buy", { owner: "adrian", slug: "humanizer" });

    const expected = {
      opens_at: "2026-12-01T00:00:00.000Z",
      public_repo_url: PUBLIC,
      licence: "MIT",
      status: "pending",
      opened_at: null,
      checked_at: null,
      evidence_url: null,
      checks: [{ id: "licence", ok: true, detail: "MIT permits resale." }],
    };
    expect(listing.isError).toBe(false);
    expect(listing.structuredContent?.open_release).toEqual(expected);
    expect(buy.structuredContent?.open_release).toEqual(expected);
  });

  it("checks a promise whose date has passed on read, so the agent sees Opened on time", async () => {
    const seeded = seedOpen({ opens_at: "2026-10-01T00:00:00.000Z" });
    setPublicGithub(stubPublicGithub({ commits: { "adrian/humanizer-public": [COMMIT] }, licences: { "adrian/humanizer-public": "MIT" }, tags: { "adrian/humanizer-public": { [COMMIT]: "v1.2.0" } } }));
    const client = await connect();

    const result = await call(client, "get_listing", { owner: "adrian", slug: "humanizer" });

    expect(result.structuredContent?.open_release).toMatchObject({
      status: "opened_on_time",
      evidence_url: `https://github.com/adrian/humanizer-public/commit/${COMMIT}`,
    });
    expect(mock.rows("release").find((r) => r.id === seeded.latest.id)!.promise_status).toBe("opened_on_time");
  });
});
