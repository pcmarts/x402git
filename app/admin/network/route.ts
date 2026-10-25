/**
 * POST /admin/network — switch every admin page between mainnet and testnet.
 *
 * Sends the operator back to the page they switched from, query and all, taken from the
 * same-origin `Referer` when there is one and from the form's pathname otherwise.
 */

import { requireAdminRoute } from "@/lib/admin/guard";
import { NETWORK_COOKIE, networkFrom, safeAdminPath } from "@/lib/admin/network";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { back } from "@/lib/web/dashboard";
import { cookieOptions } from "@/lib/web/session";

export const dynamic = "force-dynamic";

const YEAR_SEC = 365 * 24 * 60 * 60;

export const POST = handle(async (req: Request) => {
  const admin = await requireAdminRoute(req, "/admin");
  if (admin instanceof Response) return admin;

  const form = await req.formData();
  const net = networkFrom(String(form.get("net") ?? ""));

  const referer = req.headers.get("referer");
  const sameOrigin = referer && new URL(referer).origin === new URL(appUrl()).origin;
  const page = safeAdminPath(sameOrigin ? referer : String(form.get("back") ?? ""));

  const res = back(page);
  res.cookies.set(NETWORK_COOKIE, net, cookieOptions(YEAR_SEC, appUrl()));
  return res;
});
