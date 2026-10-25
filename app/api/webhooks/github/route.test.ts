import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";

const SECRET = "shhh-webhook-secret";

const cutRelease = vi.fn(async () => ({ ok: true as const, release: { id: "r1", scan: "pass" } as any }));

vi.mock("@/lib/release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/release")>()),
  cutRelease: (...args: unknown[]) => cutRelease(...(args as [])),
}));

const { POST, deliveryAge, verifySignature } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let delivery = 0;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function post(event: string, payload: unknown, options: { signature?: string; deliveryId?: string } = {}): NextRequest {
  const body = JSON.stringify(payload);
  return new NextRequest("https://x402git.com/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.deliveryId ?? `delivery-${++delivery}`,
      "x-hub-signature-256": options.signature ?? sign(body),
    },
    body,
  });
}

const pushPayload = (overrides: Record<string, unknown> = {}) => ({
  ref: "refs/tags/v1.2.0",
  head_commit: { timestamp: new Date().toISOString() },
  installation: { id: 4242 },
  repository: { id: 999, name: "widget", full_name: "octo/widget" },
  ...overrides,
});

beforeEach(() => {
  process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  resetEnv();
  cutRelease.mockClear();
  cutRelease.mockResolvedValue({ ok: true, release: { id: "r1", scan: "pass" } as any });
  mock = makeMockDb({
    creator: [{ id: "c1", handle: "adrian", onboarded_via: "api", payout_address: "0x1", terms_version: "v1" }],
    listing: [{ id: "l1", creator_id: "c1", slug: "widget", source: "github", installation_id: "4242", github_repo_id: "999" }],
  });
  setDb(mock.client as unknown as Db);
});

afterEach(() => {
  resetDb();
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  resetEnv();
});

describe("signature (FR-8.1)", () => {
  it("refuses a bad signature with 401 and does no work", async () => {
    const res = await POST(post("push", pushPayload(), { signature: "sha256=deadbeef" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_signature");
    expect(cutRelease).not.toHaveBeenCalled();
  });

  it("refuses a missing signature", async () => {
    const body = JSON.stringify(pushPayload());
    const req = new NextRequest("https://x402git.com/api/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "push", "x-github-delivery": "d-nosig" },
      body,
    });
    expect((await POST(req)).status).toBe(401);
  });

  it("verifies over the raw body, so a re-serialised payload does not match", () => {
    const raw = '{"a":1,"b":2}';
    expect(verifySignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifySignature('{"b":2,"a":1}', sign(raw), SECRET)).toBe(false);
    expect(verifySignature(raw, "sha256=short", SECRET)).toBe(false);
  });

  it("refuses everything when no secret is configured", async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    resetEnv();
    expect((await POST(post("ping", {}))).status).toBe(401);
  });
});

describe("freshness and dedupe (FR-8.1)", () => {
  it("refuses a delivery older than five minutes", async () => {
    const stale = pushPayload({ head_commit: { timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } });
    const res = await POST(post("push", stale));
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("stale_delivery");
    expect(cutRelease).not.toHaveBeenCalled();
  });

  it("accepts a delivery whose payload carries no usable timestamp", () => {
    expect(deliveryAge("installation_repositories", { action: "removed" })).toBeNull();
    expect(deliveryAge("push", { repository: { pushed_at: 1_700_000_000 } }, 1_700_000_060_000)).toBe(60_000);
    expect(deliveryAge("push", { head_commit: { timestamp: "not a date" } })).toBeNull();
  });

  /**
   * `git tag v1.0.0 <old-sha> && git push --tags` is an ordinary way to cut a release, and
   * the commit it points at can be months old. FR-8.1's five minutes is the age of the
   * *delivery*, so the push time wins over the commit time.
   */
  it("dates a tag push by the push, not by the commit it points at (FR-8.1)", async () => {
    const now = Date.now();
    const oldCommit = new Date(now - 90 * 86_400_000).toISOString();

    expect(deliveryAge("push", { repository: { pushed_at: 1_700_000_000 }, head_commit: { timestamp: oldCommit } }, 1_700_000_060_000)).toBe(
      60_000,
    );

    const res = await POST(
      post("push", pushPayload({ head_commit: { timestamp: oldCommit }, repository: { id: 999, pushed_at: Math.floor(now / 1000) } })),
    );
    expect(res.status).toBe(200);
    expect(cutRelease).toHaveBeenCalledWith({ listingId: "l1", ref: "refs/tags/v1.2.0" });
  });

  /**
   * GitHub's Redeliver button replays the *same* `X-GitHub-Delivery`, and FR-8.2 names it
   * as a recovery path. Holding the claim after a failed delivery would make it a no-op.
   */
  it("releases the delivery claim when the delivery failed, so a redelivery can retry", async () => {
    cutRelease.mockRejectedValueOnce(new Error("boom"));
    const payload = pushPayload();

    const first = await POST(post("push", payload, { deliveryId: "retry-me" }));
    expect((await first.json()).reason).toBe("error");
    expect(mock.rows("webhook_delivery")).toHaveLength(0);

    const second = await POST(post("push", payload, { deliveryId: "retry-me" }));
    expect(second.status).toBe(200);
    expect(cutRelease).toHaveBeenCalledTimes(2);
  });

  it("handles a redelivery exactly once", async () => {
    const payload = pushPayload();
    const first = await POST(post("push", payload, { deliveryId: "same-id" }));
    const second = await POST(post("push", payload, { deliveryId: "same-id" }));

    expect(first.status).toBe(200);
    expect((await second.json()).reason).toBe("duplicate_delivery");
    expect(cutRelease).toHaveBeenCalledTimes(1);
    expect(mock.rows("webhook_delivery")).toHaveLength(1);
  });
});

describe("routing", () => {
  it("answers ping", async () => {
    const res = await POST(post("ping", { zen: "Keep it logically awesome." }));
    expect(res.status).toBe(200);
    expect((await res.json()).pong).toBe(true);
  });

  it("cuts a release from a version tag push", async () => {
    const res = await POST(post("push", pushPayload()));
    expect(res.status).toBe(200);
    expect(cutRelease).toHaveBeenCalledWith({ listingId: "l1", ref: "refs/tags/v1.2.0" });
  });

  it("ignores a branch push, a deleted tag and a non-version tag", async () => {
    await POST(post("push", pushPayload({ ref: "refs/heads/main" })));
    await POST(post("push", pushPayload({ deleted: true })));
    await POST(post("push", pushPayload({ ref: "refs/tags/nightly" })));
    expect(cutRelease).not.toHaveBeenCalled();
  });

  it("cuts a release when a GitHub release is published, and ignores other actions", async () => {
    const published = {
      action: "published",
      installation: { id: 4242 },
      repository: { id: 999 },
      release: { tag_name: "v2.0.0", published_at: new Date().toISOString() },
    };
    await POST(post("release", published));
    expect(cutRelease).toHaveBeenCalledWith({ listingId: "l1", ref: "v2.0.0" });

    cutRelease.mockClear();
    await POST(post("release", { ...published, action: "edited" }));
    expect(cutRelease).not.toHaveBeenCalled();
  });

  it("reports version_exists as a 202, not an error", async () => {
    cutRelease.mockResolvedValue({ ok: false, code: "version_exists", message: "already" } as any);
    const res = await POST(post("push", pushPayload()));
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("version_exists");
  });

  it("never returns a 5xx when the pipeline throws", async () => {
    cutRelease.mockRejectedValue(new Error("boom"));
    const res = await POST(post("push", pushPayload()));
    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("error");
  });
});

describe("listing resolution (FR-8.1)", () => {
  it("resolves by installation id and repo id, never by name", async () => {
    mock.rows("listing")[0].github_repo_id = "111";
    const res = await POST(post("push", pushPayload({ repository: { id: 999, name: "widget", full_name: "adrian/widget" } })));

    expect(res.status).toBe(202);
    expect((await res.json()).reason).toBe("unknown_listing");
    expect(cutRelease).not.toHaveBeenCalled();
  });

  it("still finds a renamed repository", async () => {
    const res = await POST(post("push", pushPayload({ repository: { id: 999, name: "renamed", full_name: "octo/renamed" } })));
    expect(res.status).toBe(200);
    expect(cutRelease).toHaveBeenCalled();
  });

  it("cuts a release for every listing on the repo, not just one (FR-8)", async () => {
    // Nothing stops one repo backing several listings — §12 is only unique on
    // (creator_id, slug). This ended in `.maybeSingle()`, which makes PostgREST *error* on
    // the second row, and the throw was swallowed by the handler's catch-all: the repo
    // silently stopped producing releases the moment it was listed twice. Seen live on
    // pcmarts/x402git-e2e-rail-a, which had accumulated four listings across FR-34 runs.
    mock.rows("listing").push({ id: "l2", creator_id: "c1", slug: "widget-pro", source: "github", installation_id: "4242", github_repo_id: "999" });

    const res = await POST(post("push", pushPayload()));

    expect(res.status).toBe(200);
    expect(cutRelease).toHaveBeenCalledWith({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(cutRelease).toHaveBeenCalledWith({ listingId: "l2", ref: "refs/tags/v1.2.0" });
    expect((await res.json()).results).toHaveLength(2);
  });

  it("gives the other listings their release when one of them fails, oldest first", async () => {
    mock.rows("listing")[0].created_at = "2026-01-01T00:00:00.000Z";
    mock.rows("listing").push({ id: "l2", creator_id: "c1", slug: "widget-pro", source: "github", installation_id: "4242", github_repo_id: "999", created_at: "2026-01-02T00:00:00.000Z" });
    cutRelease
      .mockResolvedValueOnce({ ok: false, code: "version_exists", message: "already" } as any)
      .mockResolvedValueOnce({ ok: true, release: { id: "r2", scan: "pass" } } as any);

    const res = await POST(post("push", pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results.map((r: { listing_id: string }) => r.listing_id)).toEqual(["l1", "l2"]);
    expect(body.results[0].reason).toBe("version_exists");
    expect(body.results[1].release_id).toBe("r2");
  });

  it("is a 202 when no listing on the repo could be cut", async () => {
    mock.rows("listing").push({ id: "l2", creator_id: "c1", slug: "widget-pro", source: "github", installation_id: "4242", github_repo_id: "999" });
    cutRelease.mockResolvedValue({ ok: false, code: "version_exists", message: "already" } as any);

    const res = await POST(post("push", pushPayload()));
    expect(res.status).toBe(202);
    expect((await res.json()).ok).toBe(false);
  });

  it("skips a retired listing but still serves its live neighbour", async () => {
    mock.rows("listing")[0].retired_at = new Date().toISOString();
    mock.rows("listing").push({ id: "l2", creator_id: "c1", slug: "widget-pro", source: "github", installation_id: "4242", github_repo_id: "999" });

    const res = await POST(post("push", pushPayload()));

    expect(res.status).toBe(200);
    expect(cutRelease).toHaveBeenCalledTimes(1);
    expect(cutRelease).toHaveBeenCalledWith({ listingId: "l2", ref: "refs/tags/v1.2.0" });
  });

  it("refuses to cross installations", async () => {
    const res = await POST(post("push", pushPayload({ installation: { id: 5555 } })));
    expect((await res.json()).reason).toBe("unknown_listing");
  });

  it("accepts an unknown listing with a 202 so GitHub does not disable the hook", async () => {
    mock.tables.listing = [];
    expect((await POST(post("push", pushPayload()))).status).toBe(202);
  });
});

describe("retirement (FR-43)", () => {
  it("retires every listing when the installation is deleted", async () => {
    const res = await POST(post("installation", { action: "deleted", installation: { id: 4242, created_at: new Date().toISOString() } }));
    expect(res.status).toBe(200);
    expect((await res.json()).retired).toBe(1);
    expect(mock.rows("listing")[0].retired_at).toBeTruthy();
    expect(mock.rows("event").map((e) => e.name)).toEqual(["listing_retired"]);
  });

  it("ignores an installation created event", async () => {
    await POST(post("installation", { action: "created", installation: { id: 4242, created_at: new Date().toISOString() } }));
    expect(mock.rows("listing")[0].retired_at).toBeNull();
  });

  it("does not retire on a suspension — retirement is terminal, a suspension is not", async () => {
    await POST(post("installation", { action: "suspend", installation: { id: 4242, updated_at: new Date().toISOString() } }));
    expect(mock.rows("listing")[0].retired_at).toBeNull();
  });

  it("retires only the removed repository", async () => {
    mock.rows("listing").push({
      id: "l2",
      creator_id: "c1",
      slug: "other",
      source: "github",
      installation_id: "4242",
      github_repo_id: "1000",
      retired_at: null,
    });

    const res = await POST(
      post("installation_repositories", { action: "removed", installation: { id: 4242 }, repositories_removed: [{ id: 999 }] }),
    );

    expect((await res.json()).retired).toBe(1);
    expect(mock.rows("listing").find((l) => l.id === "l1")!.retired_at).toBeTruthy();
    expect(mock.rows("listing").find((l) => l.id === "l2")!.retired_at).toBeNull();
  });
});
