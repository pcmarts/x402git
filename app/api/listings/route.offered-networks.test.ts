/**
 * POST /api/listings — `offered_networks` on create (25 Oct 2026, migration 20261025213000).
 *
 * The same checks as PATCH, and before anything is provisioned: a hosted listing whose
 * rails are refused must not leave a repository behind to roll back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { req, seedCreator } from "@/lib/test/listings-fixtures";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const hosted = vi.hoisted(() => ({ provisionHostedRepo: vi.fn(), deleteHostedRepo: vi.fn(async () => undefined) }));
vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  ...hosted,
}));
vi.mock("@/lib/github/installations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/installations")>()),
  installationAccount: vi.fn(),
  userOwnsInstallation: vi.fn(),
  userCanSellRepo: vi.fn(),
  resolveRepo: vi.fn(),
  repoById: vi.fn(),
}));
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { POST } = await import("./route");

const railB = { slug: "humanizer", source: "hosted", ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample agent@x402git" };

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
  resetEnv();
  seedCreator(mock);
  hosted.provisionHostedRepo.mockResolvedValue({
    org: "x402git-hosted-01",
    name: "a1b2c3--humanizer",
    repoId: 987654,
    deployKeyId: 5150,
    remote: "git@github.com:x402git-hosted-01/a1b2c3--humanizer.git",
    defaultBranch: "main",
    installationId: 42,
    sshHostKeyFingerprints: ["SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"],
  });
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
});

describe("POST /api/listings — offered_networks", () => {
  it("stores the creator's choice of rails on the new listing", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railB, offered_networks: ["eip155:42161"] } }));
    expect(res.status).toBe(201);
    expect(mock.rows("listing")[0].offered_networks).toEqual(["eip155:42161"]);
  });

  it("leaves the column at its default (every rail) when omitted or null", async () => {
    await POST(req("/api/listings", { method: "POST", body: { ...railB, offered_networks: null } }));
    expect(mock.rows("listing")[0].offered_networks).toBeNull();
  });

  it("refuses a network the deployment does not serve before provisioning anything", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railB, offered_networks: ["stellar:pubnet"] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details).toMatchObject({ field: "offered_networks" });
    expect(hosted.provisionHostedRepo).not.toHaveBeenCalled();
    expect(mock.rows("listing")).toHaveLength(0);
  });
});
