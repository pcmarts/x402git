import { validateDiscoveryExtension, validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { ResourceGrantResponse } from "@/lib/schemas";
import { GRANT_OUTPUT_SCHEMA, bazaarExtensions, discoveryHints, serviceMetadata, serviceName, tags } from "./bazaar";

const REF = { owner: "adrian", slug: "humanizer" };

describe("the Bazaar declaration on the 402 (lib/x402/bazaar.ts)", () => {
  it("declares a GET resource the facilitator's validator accepts", () => {
    const ext = bazaarExtensions(REF, "1.2.0", "https://x402git.test");
    const bazaar = ext.bazaar as Parameters<typeof validateDiscoveryExtension>[0];

    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    expect(validateDiscoveryExtensionSpec(bazaar as unknown as Record<string, unknown>)).toEqual({ valid: true });
    expect(bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(bazaar.info.output).toMatchObject({ example: expect.objectContaining({ version: "1.2.0" }) });
  });

  it("describes the 200 with exactly the fields ResourceGrantResponse has", () => {
    expect(Object.keys(GRANT_OUTPUT_SCHEMA.properties).sort()).toEqual(Object.keys(ResourceGrantResponse.shape).sort());
    expect([...GRANT_OUTPUT_SCHEMA.required].sort()).toEqual(Object.keys(ResourceGrantResponse.shape).sort());
  });

  it("does not collapse listings into one entry: no routeTemplate", () => {
    const { bazaar } = bazaarExtensions(REF, "1.0.0", "https://x402git.test") as { bazaar: { routeTemplate?: string } };
    expect(bazaar.routeTemplate).toBeUndefined();
  });

  it("names the service `owner/slug` when it fits, and the slug when it does not", () => {
    expect(serviceName(REF)).toBe("adrian/humanizer");
    expect(serviceName({ owner: "pcmarts", slug: "crypto-balanced-portolio-builder" })).toBe("crypto-balanced-portolio-builder");
    expect(serviceName({ owner: "a", slug: "x".repeat(40) })).toBe("x".repeat(32));
  });

  it("derives tags from computed facts only, at most five, lower-cased, de-duplicated", () => {
    const hints = discoveryHints({
      computed: {
        artifact_class: "Toolkit",
        component_inventory: [
          { kind: "skill", count: 1 },
          { kind: "script", count: 3 },
          { kind: "prompt", count: 0 },
        ],
        languages: { TypeScript: 9000, Shell: 100, Python: 5000, Toolkit: 1 },
      },
      self_reported: { description: "the best toolkit ever", topics: ["marketing"] },
    });
    expect(tags(hints)).toEqual(["toolkit", "skill", "script", "typescript", "python"]);
    expect(serviceMetadata(REF, hints)).toEqual({ serviceName: "adrian/humanizer", tags: ["toolkit", "skill", "script", "typescript", "python"] });
  });

  it("tolerates a missing or malformed manifest", () => {
    expect(discoveryHints(null)).toEqual({ artifactClass: null, languages: {}, components: [] });
    expect(discoveryHints({ computed: { languages: "nope", component_inventory: 3 } })).toEqual({ artifactClass: null, languages: {}, components: [] });
    expect(serviceMetadata(REF, discoveryHints(undefined))).toEqual({ serviceName: "adrian/humanizer" });
  });
});
