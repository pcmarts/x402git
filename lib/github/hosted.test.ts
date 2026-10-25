/**
 * Rail B provisioning, against a fake Octokit. Nothing here touches the network: the
 * point is the *sequence* of calls — private repo, `main`, write deploy key — because
 * getting any one of them wrong is a silent failure rather than an error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  request: vi.fn(),
  installationRequest: vi.fn(),
  currentHostedOrg: vi.fn(() => "x402git-hosted-01"),
}));

vi.mock("@/lib/github/app", () => ({
  githubApp: () => ({ octokit: { request: app.request } }),
  installationOctokit: async () => ({ request: app.installationRequest }),
  currentHostedOrg: app.currentHostedOrg,
}));

const {
  DeployKeyRejected,
  GITHUB_SSH_HOST_KEY_FINGERPRINTS,
  archiveHostedRepo,
  commitLicenceFile,
  deleteHostedRepo,
  hostedRemote,
  hostedRepoName,
  provisionHostedRepo,
  resetHostedCache,
  rotateDeployKey,
} = await import("./hosted");

/** Route a request by its OpenAPI route string, so assertions read like the API docs. */
function respondWith(handlers: Record<string, (params: any) => any>) {
  app.installationRequest.mockImplementation(async (route: string, params: any) => {
    const handler = handlers[route];
    if (!handler) throw Object.assign(new Error(`unexpected route ${route}`), { status: 404 });
    return { data: handler(params) };
  });
}

beforeEach(() => {
  resetHostedCache();
  app.request.mockResolvedValue({ data: { id: 42 } });
  respondWith({
    "POST /orgs/{org}/repos": (p) => ({ id: 987654, name: p.name, private: true, default_branch: "main" }),
    "POST /repos/{owner}/{repo}/keys": () => ({ id: 5150 }),
  });
});

afterEach(() => vi.clearAllMocks());

describe("provisionHostedRepo (FR-7, D10, §14.6)", () => {
  it("creates a private, auto-initialised repo named <handle>--<slug>", async () => {
    const repo = await provisionHostedRepo({ handle: "a1b2c3", slug: "humanizer", sshPublicKey: "ssh-ed25519 AAAA test" });

    const [route, params] = app.installationRequest.mock.calls[0];
    expect(route).toBe("POST /orgs/{org}/repos");
    expect(params).toMatchObject({ org: "x402git-hosted-01", name: "a1b2c3--humanizer", private: true, auto_init: true });

    expect(repo.repoId).toBe(987654);
    expect(repo.remote).toBe("git@github.com:x402git-hosted-01/a1b2c3--humanizer.git");
    expect(repo.defaultBranch).toBe("main");
  });

  it("adds the key as a **write** deploy key on that repo alone", async () => {
    const repo = await provisionHostedRepo({ handle: "a1b2c3", slug: "humanizer", sshPublicKey: "  ssh-ed25519 AAAA test  " });

    const [route, params] = app.installationRequest.mock.calls[1];
    expect(route).toBe("POST /repos/{owner}/{repo}/keys");
    expect(params).toMatchObject({ owner: "x402git-hosted-01", repo: "a1b2c3--humanizer", read_only: false });
    expect(params.key).toBe("ssh-ed25519 AAAA test");
    expect(repo.deployKeyId).toBe(5150);
  });

  it("renames the default branch when the org's default is not `main`", async () => {
    respondWith({
      "POST /orgs/{org}/repos": (p) => ({ id: 1, name: p.name, private: true, default_branch: "master" }),
      "POST /repos/{owner}/{repo}/branches/{branch}/rename": () => ({ name: "main" }),
      "POST /repos/{owner}/{repo}/keys": () => ({ id: 2 }),
    });

    const repo = await provisionHostedRepo({ handle: "a1b2c3", slug: "humanizer", sshPublicKey: "ssh-ed25519 AAAA" });
    expect(repo.defaultBranch).toBe("main");
    expect(app.installationRequest.mock.calls[1][1]).toMatchObject({ branch: "master", new_name: "main" });
  });

  it("discovers the installation on the org rather than taking one from configuration (D10)", async () => {
    await provisionHostedRepo({ handle: "a1b2c3", slug: "one", sshPublicKey: "ssh-ed25519 AAAA" });
    await provisionHostedRepo({ handle: "a1b2c3", slug: "two", sshPublicKey: "ssh-ed25519 BBBB" });

    expect(app.request).toHaveBeenCalledWith("GET /orgs/{org}/installation", { org: "x402git-hosted-01" });
    // Memoised: an installation id is stable, and this is the only extra round trip.
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it("publishes github.com's host key fingerprints so an agent need not trust on first use", async () => {
    const repo = await provisionHostedRepo({ handle: "a1b2c3", slug: "humanizer", sshPublicKey: "ssh-ed25519 AAAA" });
    expect(repo.sshHostKeyFingerprints).toEqual([...GITHUB_SSH_HOST_KEY_FINGERPRINTS]);
    expect(repo.sshHostKeyFingerprints).toHaveLength(3);
    for (const fingerprint of repo.sshHostKeyFingerprints) expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe("a deploy key GitHub will not take (§14.6)", () => {
  /** GitHub's 422 for a public key already registered on another repository. */
  function keyInUse() {
    return Object.assign(new Error("Validation Failed"), {
      status: 422,
      response: { data: { errors: [{ resource: "PublicKey", message: "key is already in use" }] } },
    });
  }

  it("is a typed rejection, not a raw Octokit error, so the API can answer with a 400", async () => {
    respondWith({
      "POST /orgs/{org}/repos": (p: any) => ({ id: 1, name: p.name, private: true, default_branch: "main" }),
      "POST /repos/{owner}/{repo}/keys": () => {
        throw keyInUse();
      },
      "DELETE /repos/{owner}/{repo}": () => ({}),
    });

    await expect(provisionHostedRepo({ handle: "a1b2c3", slug: "humanizer", sshPublicKey: "ssh-ed25519 AAAA test" })).rejects.toBeInstanceOf(
      DeployKeyRejected,
    );
  });

  it("deletes the repo it just created rather than leaving an orphan holding the name", async () => {
    respondWith({
      "POST /orgs/{org}/repos": (p: any) => ({ id: 1, name: p.name, private: true, default_branch: "main" }),
      "POST /repos/{owner}/{repo}/keys": () => {
        throw keyInUse();
      },
      "DELETE /repos/{owner}/{repo}": () => ({}),
    });

    await expect(provisionHostedRepo({ handle: "a1b2c3", slug: "humanizer", sshPublicKey: "ssh-ed25519 AAAA test" })).rejects.toThrow();

    const routes = app.installationRequest.mock.calls.map((call: any[]) => call[0]);
    expect(routes).toEqual(["POST /orgs/{org}/repos", "POST /repos/{owner}/{repo}/keys", "DELETE /repos/{owner}/{repo}"]);
  });
});

describe("rotateDeployKey (§14.6)", () => {
  it("adds the new key before removing the old one", async () => {
    respondWith({
      "POST /repos/{owner}/{repo}/keys": () => ({ id: 6200 }),
      "DELETE /repos/{owner}/{repo}/keys/{key_id}": () => ({}),
    });

    const id = await rotateDeployKey({ owner: "x402git-hosted-01", repo: "a1b2c3--humanizer" }, 5150, "ssh-ed25519 NEW");
    expect(id).toBe(6200);
    expect(app.installationRequest.mock.calls.map((c) => c[0])).toEqual([
      "POST /repos/{owner}/{repo}/keys",
      "DELETE /repos/{owner}/{repo}/keys/{key_id}",
    ]);
  });

  it("keeps the new key even if the old one cannot be removed", async () => {
    app.installationRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/keys") return { data: { id: 6200 } };
      throw new Error("key not found");
    });

    await expect(rotateDeployKey({ owner: "o", repo: "r" }, 5150, "ssh-ed25519 NEW")).resolves.toBe(6200);
  });
});

describe("archive and delete (FR-43, FR-44)", () => {
  it("archives rather than deletes on retire", async () => {
    respondWith({ "PATCH /repos/{owner}/{repo}": () => ({}) });
    await archiveHostedRepo({ owner: "o", repo: "r" });
    expect(app.installationRequest).toHaveBeenCalledWith("PATCH /repos/{owner}/{repo}", { owner: "o", repo: "r", archived: true });
  });

  it("removes the deploy key before the repo, so a half-failure leaves no live write key", async () => {
    respondWith({
      "DELETE /repos/{owner}/{repo}/keys/{key_id}": () => ({}),
      "DELETE /repos/{owner}/{repo}": () => ({}),
    });

    await deleteHostedRepo({ owner: "o", repo: "r" }, 5150);
    expect(app.installationRequest.mock.calls.map((c) => c[0])).toEqual([
      "DELETE /repos/{owner}/{repo}/keys/{key_id}",
      "DELETE /repos/{owner}/{repo}",
    ]);
  });
});

describe("commitLicenceFile (FR-11)", () => {
  it("commits the LICENSE to main, base64-encoded, with no prior sha when there is no file", async () => {
    respondWith({ "PUT /repos/{owner}/{repo}/contents/{path}": () => ({ commit: { sha: "d".repeat(40) } }) });

    const result = await commitLicenceFile({ owner: "x402git-hosted-01", repo: "a1b2c3--humanizer" }, "MIT", "a1b2c3");
    expect(result.commitSha).toBe("d".repeat(40));

    const put = app.installationRequest.mock.calls.find((c) => c[0] === "PUT /repos/{owner}/{repo}/contents/{path}")![1];
    expect(put).toMatchObject({ path: "LICENSE", branch: "main", message: "Add MIT LICENSE" });
    expect(put.sha).toBeUndefined();
    expect(Buffer.from(put.content, "base64").toString("utf8")).toContain("Copyright (c) ");
    expect(Buffer.from(put.content, "base64").toString("utf8")).toContain("a1b2c3");
  });

  it("passes the existing blob sha when a LICENSE is already there", async () => {
    respondWith({
      "GET /repos/{owner}/{repo}/contents/{path}": () => ({ sha: "e".repeat(40), type: "file" }),
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({ commit: { sha: "f".repeat(40) } }),
    });

    await commitLicenceFile({ owner: "o", repo: "r" }, "Apache-2.0", "a1b2c3");
    const put = app.installationRequest.mock.calls.find((c) => c[0] === "PUT /repos/{owner}/{repo}/contents/{path}")![1];
    expect(put.sha).toBe("e".repeat(40));
  });
});

describe("naming", () => {
  it("is `<handle>--<slug>`, and the remote is SSH", () => {
    expect(hostedRepoName("a1b2c3", "humanizer")).toBe("a1b2c3--humanizer");
    expect(hostedRemote("x402git-hosted-01", "a1b2c3--humanizer")).toBe("git@github.com:x402git-hosted-01/a1b2c3--humanizer.git");
  });
});
