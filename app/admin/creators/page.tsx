/**
 * GET /admin/creators — moved to `/admin/users` on 2026-09-14, where creators are a filter.
 * Each creator's own page stays at `/admin/creators/:handle`.
 */

import { redirect } from "next/navigation";

export default async function AdminCreatorsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const params = new URLSearchParams({ role: "creators" });
  if (q) params.set("q", q);
  redirect(`/admin/users?${params}`);
}
