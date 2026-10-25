import { describe, expect, it } from "vitest";
import { TarLimitError, normalisePath, readTar, writeTar } from "@/lib/tar";

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("tar writer/reader", () => {
  it("round-trips files and directories", () => {
    const archive = writeTar([
      { path: "root", type: "directory" },
      { path: "root/README.md", body: text("# hello") },
      { path: "root/src/index.ts", body: text("export const a = 1;\n") },
    ]);
    const entries = readTar(archive);

    expect(entries.map((e) => e.path)).toEqual(["root", "root/README.md", "root/src/index.ts"]);
    expect(entries[0].type).toBe("directory");
    expect(decode(entries[1].body)).toBe("# hello");
    expect(decode(entries[2].body)).toBe("export const a = 1;\n");
  });

  it("is deterministic: the same tree always produces the same bytes", () => {
    const files = [
      { path: "a/one.txt", body: text("one") },
      { path: "a/two.txt", body: text("two") },
    ];
    const first = writeTar(files);
    // Reversed input, because entries are sorted before they are written.
    const second = writeTar([...files].reverse());
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("preserves the executable bit and normalises everything else", () => {
    const archive = writeTar([
      { path: "bin/run.sh", body: text("#!/bin/sh\n"), executable: true },
      { path: "docs/readme.md", body: text("hi") },
    ]);
    const entries = readTar(archive);
    expect(entries.find((e) => e.path === "bin/run.sh")!.mode & 0o111).not.toBe(0);
    expect(entries.find((e) => e.path === "docs/readme.md")!.mode & 0o111).toBe(0);
  });

  it("carries a path too long for the ustar header in a PAX record", () => {
    const long = `${"segment/".repeat(20)}file.txt`;
    const archive = writeTar([{ path: long, body: text("deep") }]);
    const entries = readTar(archive);
    expect(entries.map((e) => e.path)).toEqual([long]);
    expect(decode(entries[0].body)).toBe("deep");
  });

  it("splits a moderately long path across name and prefix", () => {
    const path = `${"dir/".repeat(30)}f.txt`; // 125 chars: too long for `name`, fits with `prefix`
    const entries = readTar(writeTar([{ path, body: text("x") }]));
    expect(entries[0].path).toBe(path);
  });

  it("enforces the file-count cap", () => {
    const archive = writeTar(Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, body: text("x") })));
    expect(() => readTar(archive, { maxEntries: 3 })).toThrow(TarLimitError);
  });

  // W3.6: the cap is checked before the push, so `entries` never exceeds `maxEntries` — an
  // archive of exactly `maxEntries + 1` is rejected, and nothing over the cap is held first.
  it("rejects an archive one entry over the cap without ever exceeding it (W3.6)", () => {
    const maxEntries = 3;
    const archive = writeTar(Array.from({ length: maxEntries + 1 }, (_, i) => ({ path: `f${i}.txt`, body: text("x") })));
    expect(() => readTar(archive, { maxEntries })).toThrow(TarLimitError);
    // At the cap exactly, it reads clean and holds no more than `maxEntries`.
    const atCap = writeTar(Array.from({ length: maxEntries }, (_, i) => ({ path: `f${i}.txt`, body: text("x") })));
    const entries = readTar(atCap, { maxEntries });
    expect(entries.length).toBeLessThanOrEqual(maxEntries);
  });

  it("enforces the byte cap", () => {
    const archive = writeTar([{ path: "big.bin", body: new Uint8Array(4096) }]);
    expect(() => readTar(archive, { maxBytes: 1024 })).toThrow(TarLimitError);
  });

  it("rejects a corrupted header rather than returning a partial tree", () => {
    const archive = writeTar([{ path: "a.txt", body: text("a") }]);
    archive[10] = 0x41; // scribble on the mode field; the checksum no longer matches
    expect(() => readTar(archive)).toThrow(/checksum/);
  });

  it("rejects a truncated archive", () => {
    const archive = writeTar([{ path: "a.txt", body: text("a".repeat(2000)) }]);
    expect(() => readTar(archive.subarray(0, 600))).toThrow(/truncated/);
  });

  it("normalises paths that try to escape the archive root", () => {
    expect(normalisePath("/etc/passwd")).toBe("etc/passwd");
    expect(normalisePath("../../secrets")).toBe("secrets");
    expect(normalisePath("a/./b/../c")).toBe("a/b/c");
    expect(normalisePath("a\\b")).toBe("a/b");
  });
});
