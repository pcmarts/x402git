import { describe, expect, it } from "vitest";
import { openApiDocument } from "@/lib/openapi";
import { ERROR_CODES } from "@/lib/errors";
import { registeredRoutes } from "./registry";

const doc = openApiDocument() as any;

describe("the OpenAPI document (FR-33)", () => {
  it("is OpenAPI 3.1 with a server", () => {
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.servers[0].url).toBeTruthy();
  });

  it("registers every §9 route", () => {
    const expected = [
      "/api/label/{owner}/{slug}", "/api/v/{owner}/{slug}", "/api/v/{owner}/{slug}/releases",
      "/api/r/{owner}/{slug}", "/api/r/{owner}/{slug}/v/{version}", "/api/entitlements",
      "/api/auth/challenge", "/api/mcp", "/api/openapi.json", "/api/terms",
      "/api/creators", "/api/creators/me", "/api/auth/rotate-key",
      "/api/listings", "/api/listings/{id}", "/api/listings/{id}/sync", "/api/listings/{id}/licence",
      "/api/listings/{id}/ssh-key", "/api/listings/{id}/publish", "/api/listings/{id}/repo",
      "/api/earnings", "/api/payouts/sweep",
      "/api/webhooks/github", "/api/cron/sweep", "/api/cron/reconcile",
      "/{owner}/{slug}",
    ];
    for (const path of expected) expect(Object.keys(doc.paths)).toContain(path);
  });

  it("marks the paid resource operations with x-payment-info for x402 indexers", () => {
    const op = doc.paths["/api/r/{owner}/{slug}"].get;
    expect(op["x-payment-info"]).toMatchObject({ protocols: [{ x402: {} }], price: { mode: "dynamic", currency: "USD" } });
    expect(op.responses["402"]).toBeTruthy();
    // The version re-fetch is for holders (FR-19); it is not a resource anyone buys.
    expect(doc.paths["/api/r/{owner}/{slug}/v/{version}"].get["x-payment-info"]).toBeUndefined();
    expect(doc.paths["/api/label/{owner}/{slug}"].get["x-payment-info"]).toBeUndefined();
  });

  it("gives the owner and slug path parameters a working example, for probers", () => {
    const params = doc.paths["/api/r/{owner}/{slug}"].get.parameters as { name: string; schema: { example?: string } }[];
    expect(params.find((p) => p.name === "owner")?.schema.example).toBe("examples");
    expect(params.find((p) => p.name === "slug")?.schema.example).toBe("humanizer");
  });

  it("marks public operations with an explicit empty security array", () => {
    expect(doc.paths["/api/label/{owner}/{slug}"].get.security).toEqual([]);
    expect(doc.paths["/api/listings"].post.security).toEqual([{ apiKey: [] }]);
  });

  it("names a contact and guidance in info, which the x402scan crawler reads", () => {
    expect(doc.info.contact).toMatchObject({ email: expect.stringContaining("@x402git.com"), url: expect.stringContaining("/abuse") });
    expect(doc.info["x-guidance"]).toContain("/.well-known/agent-skills/buy-a-repo/SKILL.md");
  });

  it("names the licence and links the source, at the document root", () => {
    expect(doc.info.license).toEqual({ name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" });
    expect(doc.externalDocs).toEqual({ url: "https://github.com/pcmarts/x402git", description: "Source code and security policy" });
  });

  it("gives every operation a unique operationId", () => {
    const ids = registeredRoutes().map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every $ref against components.schemas", () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
    const dangling = [...new Set(refs)].filter((r) => !(r.replace("#/components/schemas/", "") in doc.components.schemas));
    expect(dangling).toEqual([]);
  });

  it("publishes the error catalogue as a component with every code in its enum", () => {
    const error = doc.components.schemas.Error;
    expect(error).toBeDefined();
    expect(error.properties.code.$ref).toBe("#/components/schemas/ErrorCode");
    const codes = doc.components.schemas.ErrorCode.enum;
    for (const code of ERROR_CODES) expect(codes).toContain(code);
  });

  it("documents both security schemes", () => {
    expect(doc.components.securitySchemes.apiKey.scheme).toBe("bearer");
    expect(doc.components.securitySchemes.walletSignature.name).toBe("X-Wallet-Signature");
  });

  it("carries one canonical 402 example per kind on /api/r (FR-21)", () => {
    const examples = doc.paths["/api/r/{owner}/{slug}"].get.responses["402"].content["application/json"].examples;
    expect(Object.keys(examples).sort()).toEqual(["new", "update"]);
    expect(examples.update.value.extra.kind).toBe("update");
    expect(examples.update.value.extra.releases).toBeDefined();
    expect(examples.new.value.extra.kind).toBe("new");
  });

  it("expands catalogue codes into responses with an example body each", () => {
    const conflict = doc.paths["/api/creators"].post.responses["409"];
    expect(conflict.description).toContain("terms_version_stale");
    expect(conflict.content["application/json"].examples.terms_version_stale.value.docs_url).toMatch(/#terms_version_stale$/);
  });

  it("requires the bearer key on every creator route", () => {
    for (const route of registeredRoutes()) {
      if (route.tags.includes("creator") && route.path !== "/api/creators") {
        expect(route.security).toContain("apiKey");
      }
    }
    // Registration cannot require a key: it is where the key comes from.
    expect(doc.paths["/api/creators"].post.security).toEqual([]);
  });

  it("encodes every amount as a string, never a number", () => {
    for (const [name, schema] of Object.entries<any>(doc.components.schemas)) {
      for (const [prop, value] of Object.entries<any>(schema.properties ?? {})) {
        if (/_micro$/.test(prop) && value.type) {
          expect(`${name}.${prop}: ${value.type}`).toBe(`${name}.${prop}: string`);
        }
      }
    }
  });

  it("no live handler is marked planned (W2.6)", () => {
    // The manifest page and the public label route execute; they must not read as
    // "Documented, not yet implemented" any longer.
    expect(doc.paths["/{owner}/{slug}"].get["x-status"]).toBeUndefined();
    expect(doc.paths["/api/label/{owner}/{slug}"].get["x-status"]).toBeUndefined();
    expect(doc.paths["/api/terms"].get["x-status"]).toBeUndefined();
    // FR-31 is built: the MCP server is a POST of JSON-RPC, not a planned GET.
    expect(doc.paths["/api/mcp"].post["x-status"]).toBeUndefined();
    // The listings slice is built, so it is no longer marked planned.
    expect(doc.paths["/api/listings"].post["x-status"]).toBeUndefined();

    // Every documented operation is live: nothing in the whole document is planned.
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path as Record<string, { "x-status"?: string }>)) {
        expect(op["x-status"]).toBeUndefined();
      }
    }
  });

  it("documents rate_limited on the public label route (W2.6)", () => {
    const label = doc.paths["/api/label/{owner}/{slug}"].get;
    expect(JSON.stringify(label.responses)).toContain("429");
  });
});
