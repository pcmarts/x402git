/**
 * lib/db.ts — the service-role Supabase client. Server only.
 *
 * One memoised client for the whole process. It uses SUPABASE_SECRET_KEY, so it
 * bypasses RLS: never import this from a client component, and never hand its
 * results to a caller without filtering first.
 *
 * Tests must not reach the network. Call `setDb(makeMockDb(...))` from
 * lib/test/mock-db.ts in a `beforeEach`, and `resetDb()` after.
 */

// Server-only by construction: it reads SUPABASE_SECRET_KEY. Do not import from a client component.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "@/lib/env";

/**
 * Structurally the subset of supabase-js the codebase uses. The mock in
 * lib/test/mock-db.ts satisfies this, which is why nothing outside this file
 * should reference `SupabaseClient` directly.
 */
export type Db = SupabaseClient;

let client: Db | null = null;

export function db(): Db {
  if (client) return client;
  const { url, secretKey } = supabaseConfig();
  client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "x402git" } },
  });
  return client;
}

/** Test seam. Pass a mock; call `resetDb()` afterwards. */
export function setDb(mock: Db | null): void {
  client = mock;
}

export function resetDb(): void {
  client = null;
}

/** Supabase Storage handle for the private artifacts bucket (see lib/storage.ts). */
export const ARTIFACT_BUCKET = "artifacts";

/**
 * The **public** bucket holding README images (FR-49). Separate from `artifacts`
 * because its access rule is the opposite one: nothing in here was paid for, everything
 * in here was already published by the creator in a README, and it is served without a
 * signature. See the module comment in lib/storage.ts.
 */
export const README_ASSET_BUCKET = "readme-assets";
