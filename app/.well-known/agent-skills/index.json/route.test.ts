import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { skill, SKILL_NAMES } from "@/lib/skills";
import { GET, skillsIndex } from "./route";

const index = skillsIndex("https://x402git.com");

describe("GET /.well-known/agent-skills/index.json (Agent Skills Discovery 0.2.0)", () => {
  it("declares the 0.2.0 schema and one entry per skill", () => {
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills.map((s) => s.name)).toEqual([...SKILL_NAMES]);
  });

  it("gives every skill the five required fields, with a lowercase-hyphen name", () => {
    for (const entry of index.skills) {
      expect(entry.name).toMatch(/^[a-z0-9-]+$/);
      expect(entry.type).toBe("skill-md");
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.url).toBe(`https://x402git.com/.well-known/agent-skills/${entry.name}/SKILL.md`);
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("digests the bytes it serves, not a copy of them", () => {
    for (const name of SKILL_NAMES) {
      const { text, digest } = skill(name);
      expect(digest).toBe(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`);
      // The file is the skill, not a stub: frontmatter, a heading, and something to do.
      expect(text.startsWith("---\n")).toBe(true);
      expect(text).toContain("x402git.com/api/");
    }
  });

  it("is JSON with open CORS", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
