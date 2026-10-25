#!/usr/bin/env node
/**
 * scripts/migrate-storage.mjs — copy Supabase Storage from the old project to the new one
 * for the org migration (docs/MIGRATION-PRD.md §5.5).
 *
 *   node scripts/with-env.mjs node scripts/migrate-storage.mjs --list
 *   node scripts/with-env.mjs node scripts/migrate-storage.mjs --copy
 *   node scripts/with-env.mjs node scripts/migrate-storage.mjs --verify --db old
 *
 * Always run it through scripts/with-env.mjs: this script reads only the side-explicit
 * names that wrapper exports (OLD_SUPABASE_URL / OLD_SUPABASE_SECRET_KEY and
 * NEW_SUPABASE_URL / NEW_SUPABASE_SECRET_KEY), so which project is "linked" is
 * irrelevant and neither side can be reached by accident.
 *
 * `--copy` creates the two buckets on the new side with **exactly** the options
 * `lib/storage.ts` uses — `artifacts` private, `readme-assets` public with a 2 MiB file
 * cap and the six image MIME types — because the caps are part of the security model
 * there, not a convenience. Every object is then downloaded and re-uploaded to the same
 * path with the same content type and `upsert: true`, which makes the run idempotent:
 * the cutover re-runs it to sweep up anything published since.
 *
 * `--verify` is the check §5.5 actually cares about: read every `release.storage_path`
 * from a database (`--db old`, the default, because the data copy happens after this
 * step; `--db new` once it has), download that path from the **new** `artifacts` bucket,
 * sha256 the bytes and compare to `release.artifact_sha256`. It also compares per-bucket
 * object counts and total bytes across the two sides. One mismatch fails the run.
 *
 * Storage `list` is per folder and paginated, so listing walks prefixes breadth-first and
 * pages each one. Nothing here prints a key.
 */

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ARTIFACT_BUCKET = "artifacts";
const README_ASSET_BUCKET = "readme-assets";
const PAGE = 100;

/** The bucket options must stay identical to lib/storage.ts. */
const BUCKET_OPTIONS = {
  [ARTIFACT_BUCKET]: { public: false },
  [README_ASSET_BUCKET]: {
    public: true,
    fileSizeLimit: 2 * 1024 * 1024,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp", "image/avif"],
  },
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const value = (f, fallback) => {
  const i = argv.indexOf(`--${f}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const die = (m) => {
  console.error(`error: ${m}`);
  process.exit(1);
};

const client = (side) => {
  const url = process.env[`${side}_SUPABASE_URL`];
  const key = process.env[`${side}_SUPABASE_SECRET_KEY`];
  if (!url || !key) die(`${side}_SUPABASE_URL / ${side}_SUPABASE_SECRET_KEY missing — run via scripts/with-env.mjs`);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
};

/** Every object under `bucket`, recursing into prefixes and paging each one. */
async function listAll(db, bucket) {
  const out = [];
  const queue = [""];
  while (queue.length) {
    const prefix = queue.shift();
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db.storage.from(bucket).list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const entry of data) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        // A folder placeholder has no id and no metadata; a real object has both.
        if (entry.id === null || entry.id === undefined) queue.push(path);
        else
          out.push({
            path,
            size: Number(entry.metadata?.size ?? 0),
            contentType: entry.metadata?.mimetype ?? "application/octet-stream",
          });
      }
      if (data.length < PAGE) break;
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** `--list`: what each side holds, per bucket. Missing bucket is reported, not fatal. */
async function inventory(db, label) {
  const rows = [];
  for (const bucket of [ARTIFACT_BUCKET, README_ASSET_BUCKET]) {
    const { data: info } = await db.storage.getBucket(bucket);
    if (!info) {
      rows.push({ bucket, objects: "-", bytes: "-", note: "bucket missing" });
      continue;
    }
    const objects = await listAll(db, bucket);
    rows.push({
      bucket,
      objects: objects.length,
      bytes: objects.reduce((n, o) => n + o.size, 0),
      note: info.public ? "public" : "private",
    });
  }
  for (const r of rows) console.log(`${label.padEnd(3)} ${r.bucket.padEnd(14)} ${String(r.objects).padStart(5)} objects  ${String(r.bytes).padStart(9)} bytes  (${r.note})`);
  return rows;
}

async function ensureBucket(db, bucket) {
  const { data } = await db.storage.getBucket(bucket);
  if (data) return "exists";
  const { error } = await db.storage.createBucket(bucket, BUCKET_OPTIONS[bucket]);
  if (error && !/exist/i.test(error.message)) throw new Error(`createBucket ${bucket}: ${error.message}`);
  return "created";
}

async function copy(old, neu) {
  let copied = 0;
  let bytes = 0;
  for (const bucket of [ARTIFACT_BUCKET, README_ASSET_BUCKET]) {
    console.log(`${bucket}: ${await ensureBucket(neu, bucket)} on the new side`);
    const objects = await listAll(old, bucket);
    for (const o of objects) {
      const { data, error } = await old.storage.from(bucket).download(o.path);
      if (error || !data) throw new Error(`download ${bucket}/${o.path}: ${error?.message ?? "no body"}`);
      const body = new Uint8Array(await data.arrayBuffer());
      const { error: upErr } = await neu.storage
        .from(bucket)
        .upload(o.path, body, { contentType: o.contentType, upsert: true });
      if (upErr) throw new Error(`upload ${bucket}/${o.path}: ${upErr.message}`);
      copied += 1;
      bytes += body.byteLength;
      console.log(`  copied ${bucket}/${o.path} (${body.byteLength} bytes, ${o.contentType})`);
    }
  }
  console.log(`copy done: ${copied} objects, ${bytes} bytes`);
}

/** Every release row that claims an artifact, from whichever side `--db` names. */
async function releases(db) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("release")
      .select("id, listing_id, version, storage_path, artifact_sha256")
      .not("storage_path", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`select release: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function verify(old, neu, side) {
  const failures = [];
  const rows = await releases(side === "new" ? neu : old);
  console.log(`verify: ${rows.length} release rows with a storage_path (read from the ${side} database)`);
  for (const r of rows) {
    const { data, error } = await neu.storage.from(ARTIFACT_BUCKET).download(r.storage_path);
    if (error || !data) {
      failures.push(`${r.storage_path} — missing on the new side (${error?.message ?? "no body"})`);
      continue;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (!r.artifact_sha256) {
      console.log(`  ?  ${r.storage_path} — release has no artifact_sha256; got ${sha}`);
      continue;
    }
    if (sha.toLowerCase() !== String(r.artifact_sha256).toLowerCase()) {
      failures.push(`${r.storage_path} — expected ${r.artifact_sha256}, got ${sha}`);
    } else {
      console.log(`  ok ${r.storage_path} (${bytes.byteLength} bytes)`);
    }
  }

  console.log("");
  const oldRows = await inventory(old, "old");
  const newRows = await inventory(neu, "new");
  for (const o of oldRows) {
    const n = newRows.find((x) => x.bucket === o.bucket);
    if (String(o.objects) !== String(n?.objects) || String(o.bytes) !== String(n?.bytes)) {
      failures.push(`${o.bucket} — old ${o.objects}/${o.bytes} vs new ${n?.objects}/${n?.bytes} (objects/bytes)`);
    }
  }

  if (failures.length) {
    console.error(`\nFAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("\nOK — every release hash matches and both buckets agree on count and bytes.");
}

const old = client("OLD");
const neu = client("NEW");

if (has("list")) {
  await inventory(old, "old");
  await inventory(neu, "new");
} else if (has("copy")) {
  await copy(old, neu);
} else if (has("verify")) {
  const side = value("db", "old");
  if (side !== "old" && side !== "new") die("--db must be old or new");
  await verify(old, neu, side);
} else {
  console.error("usage: node scripts/migrate-storage.mjs --list | --copy | --verify [--db old|new]");
  process.exit(2);
}
