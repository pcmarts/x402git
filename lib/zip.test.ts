import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TarLimitError } from "@/lib/tar";
import { crc32, readZip, writeZip } from "@/lib/zip";

const text = (s: string) => new TextEncoder().encode(s);

describe("writeZip / readZip", () => {
  it("round-trips paths, bodies and the directory entry", () => {
    const bytes = writeZip([
      { path: "widget-1.0.0", type: "directory" },
      { path: "widget-1.0.0/README.md", body: text("# widget\n") },
      { path: "widget-1.0.0/src/index.ts", body: text("export {};\n") },
    ]);

    const entries = readZip(bytes);
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ["widget-1.0.0", "directory"],
      ["widget-1.0.0/README.md", "file"],
      ["widget-1.0.0/src/index.ts", "file"],
    ]);
    expect(new TextDecoder().decode(entries[1].body)).toBe("# widget\n");
  });

  it("is deterministic: same tree, same bytes, whatever the input order", () => {
    const a = writeZip([
      { path: "r/a.txt", body: text("a") },
      { path: "r/b.txt", body: text("b") },
    ]);
    const b = writeZip([
      { path: "r/b.txt", body: text("b") },
      { path: "r/a.txt", body: text("a") },
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("starts with the PK local-header magic", () => {
    const bytes = writeZip([{ path: "a.txt", body: text("a") }]);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("keeps the executable bit and nothing else of the mode", () => {
    const bytes = writeZip([
      { path: "r/run.sh", body: text("#!/bin/sh\n"), executable: true },
      { path: "r/plain.txt", body: text("x") },
    ]);
    const byPath = new Map(readZip(bytes).map((e) => [e.path, e.mode]));
    expect(byPath.get("r/run.sh")).toBe(0o755);
    expect(byPath.get("r/plain.txt")).toBe(0o644);
  });

  it("stores rather than deflates when compression does not help", () => {
    // Random-ish incompressible bytes: deflate output would be larger than the input.
    const noise = new Uint8Array(256).map((_, i) => (i * 89) % 251);
    const bytes = writeZip([{ path: "n.bin", body: noise }]);
    const [entry] = readZip(bytes);
    expect(Buffer.from(entry.body).equals(Buffer.from(noise))).toBe(true);
  });

  /**
   * 13 Sep 2026. `readZip` inflated every entry eagerly with no caps at all, while the tar
   * reader beside it has taken `maxEntries`/`maxBytes` since it was written — and the
   * caller that reads a zip is the §7 rescan cron, pulling an object back out of Storage
   * and decompressing it. Both caps are decided from the central directory, so an archive
   * that declares too much is refused before anything is decompressed, and the error is
   * `TarLimitError`, which `snapshot()` already knows how to turn into `repo_too_large`.
   */
  describe("the caps (PRD §6), and the selector", () => {
    const many = (n: number) => writeZip(Array.from({ length: n }, (_, i) => ({ path: `r/f${i}.txt`, body: text(`file ${i}`) })));

    it("refuses an archive over the entry cap, before inflating anything", () => {
      const bytes = many(12);
      expect(() => readZip(bytes, { maxEntries: 10 })).toThrow(TarLimitError);
      expect(() => readZip(bytes, { maxEntries: 10 })).toThrow(/exceeds 10 entries/);
      expect(readZip(bytes, { maxEntries: 12 })).toHaveLength(12);
    });

    it("refuses an archive over the declared-bytes cap", () => {
      const bytes = writeZip([
        { path: "r/a.txt", body: text("a".repeat(600)) },
        { path: "r/b.txt", body: text("b".repeat(600)) },
      ]);
      expect(() => readZip(bytes, { maxBytes: 1000 })).toThrow(TarLimitError);
      expect(readZip(bytes, { maxBytes: 2000 })).toHaveLength(2);
    });

    it("inflates only what the caller asked for, and says which entries it skipped", () => {
      const bytes = writeZip([
        { path: "r/package.json", body: text('{"name":"r"}') },
        { path: "r/huge.bin", body: text("z".repeat(4096)) },
      ]);
      const entries = readZip(bytes, { inflate: (path) => path.endsWith("package.json") });
      const byPath = new Map(entries.map((e) => [e.path, e]));

      expect(new TextDecoder().decode(byPath.get("r/package.json")!.body)).toBe('{"name":"r"}');
      expect(byPath.get("r/package.json")!.skipped).toBeUndefined();
      // Still on the list, still carrying its declared size — just not decompressed.
      expect(byPath.get("r/huge.bin")).toMatchObject({ skipped: true, size: 4096 });
      expect(byPath.get("r/huge.bin")!.body).toHaveLength(0);
    });
  });

  it("refuses truncated bytes and a corrupted body", () => {
    const bytes = writeZip([{ path: "a.txt", body: text("hello hello hello") }]);
    expect(() => readZip(bytes.subarray(0, bytes.length - 4))).toThrow(/zip/);
    const corrupt = new Uint8Array(bytes);
    // Local header is 30 bytes + "a.txt": the file's data starts at 35. Depending on
    // where the flip lands, either inflate rejects the stream or the CRC check does.
    corrupt[36] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow();
  });

  // The one assertion no round-trip test can make: the tool a buyer actually runs
  // accepts the archive. `unzip` ships with macOS and every CI image this runs on.
  it("is readable by the system unzip", () => {
    const bytes = writeZip([
      { path: "widget-1.0.0", type: "directory" },
      { path: "widget-1.0.0/README.md", body: text("# widget\n") },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
    try {
      const file = join(dir, "a.zip");
      writeFileSync(file, bytes);
      const listing = execFileSync("unzip", ["-t", file], { encoding: "utf-8" });
      expect(listing).toContain("No errors detected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("crc32", () => {
  it("matches the known vector for '123456789'", () => {
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
  });
});
