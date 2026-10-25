import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicGithub, GithubUnreachable, parseGithubRepoUrl, publicGithub, setPublicGithub } from "./public";
import { stubPublicGithub } from "@/lib/test/public-github";

afterEach(() => {
  setPublicGithub(null);
});

describe("parseGithubRepoUrl", () => {
  it("reads owner and name from a repository URL", () => {
    expect(parseGithubRepoUrl("https://github.com/pcmarts/open-release-demo")).toEqual({ owner: "pcmarts", name: "open-release-demo" });
    expect(parseGithubRepoUrl("https://github.com/pcmarts/open-release-demo/")).toEqual({ owner: "pcmarts", name: "open-release-demo" });
    expect(parseGithubRepoUrl("https://github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
  });

  it("refuses anything that is not https://github.com/owner/name", () => {
    expect(parseGithubRepoUrl("http://github.com/o/r")).toBeNull();
    expect(parseGithubRepoUrl("https://gitlab.com/o/r")).toBeNull();
    expect(parseGithubRepoUrl("https://github.com/o")).toBeNull();
    expect(parseGithubRepoUrl("https://github.com/o/r/tree/main")).toBeNull();
    expect(parseGithubRepoUrl(null)).toBeNull();
    expect(parseGithubRepoUrl("")).toBeNull();
  });
});

describe("fetchPublicGithub — the unauthenticated REST reader", () => {
  function answering(table: Record<string, { status: number; body?: unknown }>) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const path = url.replace("https://api.github.com", "");
      const hit = table[path];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), { status: hit.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("reads a repository's visibility, a commit's presence and the licence id", async () => {
    const { fetchImpl, calls } = answering({
      "/repos/o/r": { status: 200, body: { owner: { login: "o" }, name: "r", private: false, default_branch: "main", html_url: "https://github.com/o/r" } },
      "/repos/o/r/commits/abc": { status: 200, body: { sha: "abc", html_url: "https://github.com/o/r/commit/abc" } },
      "/repos/o/r/license": { status: 200, body: { license: { spdx_id: "MIT" } } },
      "/repos/o/r/tags?per_page=100": { status: 200, body: [{ name: "v1.1.0", commit: { sha: "abc" } }] },
    });
    const github = fetchPublicGithub(fetchImpl);

    expect(await github.repo("o", "r")).toEqual({ owner: "o", name: "r", private: false, default_branch: "main", html_url: "https://github.com/o/r" });
    expect(await github.commit("o", "r", "abc")).toEqual({ sha: "abc", html_url: "https://github.com/o/r/commit/abc" });
    expect(await github.licence("o", "r")).toBe("MIT");
    expect(await github.tagFor("o", "r", "abc")).toBe("v1.1.0");
    // GitHub refuses a request with no User-Agent, and the JSON media type is asked for.
    expect(calls[0].headers["user-agent"]).toMatch(/x402git/);
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
  });

  it("treats 404 and 422 as 'not there', never as an error", async () => {
    const { fetchImpl } = answering({ "/repos/o/r/commits/zzz": { status: 422, body: { message: "No commit found for SHA: zzz" } } });
    const github = fetchPublicGithub(fetchImpl);
    expect(await github.repo("o", "missing")).toBeNull();
    expect(await github.commit("o", "r", "zzz")).toBeNull();
    expect(await github.licence("o", "r")).toBeNull();
    expect(await github.tagFor("o", "r", "zzz")).toBeNull();
  });

  it("throws GithubUnreachable on anything else, so 'could not look' is never 'not there'", async () => {
    const { fetchImpl } = answering({ "/repos/o/r/commits/abc": { status: 503, body: { message: "down" } } });
    const github = fetchPublicGithub(fetchImpl);
    await expect(github.commit("o", "r", "abc")).rejects.toBeInstanceOf(GithubUnreachable);

    const failing = fetchPublicGithub((async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    await expect(failing.repo("o", "r")).rejects.toBeInstanceOf(GithubUnreachable);
  });

  it("is swapped out whole by setPublicGithub", async () => {
    const stub = stubPublicGithub({ repos: { "o/r": { private: false } } });
    setPublicGithub(stub);
    expect(await publicGithub().repo("o", "r")).toMatchObject({ private: false });
    expect(stub.calls).toEqual(["repos/o/r"]);
  });
});
