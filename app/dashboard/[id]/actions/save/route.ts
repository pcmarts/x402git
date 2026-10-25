/**
 * POST /dashboard/:id/actions/save — the listing's editable fields, in one PATCH.
 *
 * Replaces `actions/pricing` (FR-12) and `actions/description` (FR-51), which were two
 * routes because the page had two Save buttons. It has one now, on the founder's
 * direction of 2026-08-31, and two round trips to the same `PATCH /api/listings/:id` for
 * one press would be two chances to half-save.
 *
 * The form is a set of radios plus a text field, which is what a preset list has to be
 * with JavaScript off. `*_choice` carries either a preset in micro-USDC or the literal
 * `custom`; the custom field is in dollars because that is what a person types. Parsing
 * happens once, here, with `parsePriceInput`, and the value crosses to the API as a
 * decimal string of an integer — never a float, never a JSON number.
 *
 * Price is always sent; the two text fields are sent only when they have content, because
 * `PatchListingRequest` reads an omitted field as "leave it alone" and has no way to say
 * "make this empty". A box submitted blank is therefore a no-op, and the outcome names
 * what is still outstanding — read off the response, not guessed from the form (FR-51).
 *
 * Over-length text bounces the whole POST rather than being cut to fit. The form's limits
 * are far under the API's, and a creator who pasted 340 characters into a 200-character
 * field is owed the sentence they wrote back, not the first 200 of it.
 */

import { handle } from "@/lib/errors";
import { micro } from "@/lib/schemas";
import { creatorApi } from "@/lib/web/api-client";
import { back, DESCRIPTION_LIMIT, requireActor, TRIGGER_HINT_LIMIT } from "@/lib/web/dashboard";
import { parsePriceInput, validatePrice } from "@/lib/web/money";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const target = `/dashboard/${id}`;

  const actor = await requireActor(req, target);
  if (actor instanceof Response) return actor;

  const form = await req.formData();

  let priceMicro: bigint;
  let updateMicro: bigint;
  try {
    priceMicro = choose(form.get("price_choice"), form.get("price_custom"));
    validatePrice(priceMicro);
    updateMicro = choose(form.get("update_choice"), form.get("update_custom"));
    // The same floor on a typed update price (2026-09-01, founder): D2b's arithmetic is
    // about what a settlement costs, and it does not care which of the two prices is
    // being charged. $0 stays exempt because $0 is lifetime access (D1, FR-16) and
    // reaches here as a preset, never as something a creator typed — which is also why
    // this reads `update_choice` rather than trusting the parsed number: a custom field
    // left holding "0" from a previous save must not become a silent grant of lifetime
    // access when the radio beside it says $0 was not chosen.
    if (form.get("update_choice") === "custom") validatePrice(updateMicro);
  } catch (e) {
    return back(target, { error: e instanceof Error ? e.message : "That price could not be read." });
  }

  const description = String(form.get("description") ?? "").trim();
  const triggerHint = String(form.get("trigger_hint") ?? "").trim();

  // Refused, never truncated. The counter beside the field says the same thing live
  // (char-count.tsx); this is the half that holds with scripting off, and silently
  // cutting a creator's sentence at 200 characters is the outcome both exist to avoid.
  const over =
    description.length > DESCRIPTION_LIMIT
      ? { field: "What it does", by: description.length - DESCRIPTION_LIMIT, limit: DESCRIPTION_LIMIT }
      : triggerHint.length > TRIGGER_HINT_LIMIT
        ? { field: "When to reach for it", by: triggerHint.length - TRIGGER_HINT_LIMIT, limit: TRIGGER_HINT_LIMIT }
        : null;
  if (over) {
    return back(target, {
      error: `"${over.field}" is ${over.by} character${over.by === 1 ? "" : "s"} over its ${over.limit}-character limit. Nothing was saved.`,
    });
  }

  const body: Record<string, string | boolean> = {
    price_micro: micro.serialize(priceMicro),
    update_price_micro: micro.serialize(updateMicro),
  };
  if (description) body.description = description;
  if (triggerHint) body.trigger_hint = triggerHint;

  // Open releases (25 Oct 2026). The checkbox is always sent — an unticked box posts
  // nothing, and "leave it alone" would make it impossible to turn off. The URL and the
  // day are sent only when filled, like the two text fields: the API refuses an open
  // release with either missing, and names the field. The day crosses as `YYYY-MM-DD`;
  // the service reads it as midnight UTC, or keeps an instant already set on that day.
  body.open_release = form.get("open_release") === "1";
  const publicRepoUrl = String(form.get("public_repo_url") ?? "").trim();
  const opensOn = String(form.get("next_opens_at") ?? "").trim();
  if (publicRepoUrl) body.public_repo_url = publicRepoUrl;
  if (opensOn) body.next_opens_at = opensOn;

  const result = await creatorApi<{ description?: string | null; trigger_hint?: string | null }>({
    method: "PATCH",
    path: `/api/listings/${id}`,
    apiKey: actor.apiKey,
    body,
  });
  if (!result.ok) return back(target, { error: result.message });

  const missing: string[] = [];
  if (!result.data?.description) missing.push("a description");
  if (!result.data?.trigger_hint) missing.push("a trigger hint");

  return back(target, {
    ok:
      missing.length === 0
        ? "Saved. A price change applies to future purchases only."
        : `Saved. Still needed before publishing: ${missing.join(" and ")}.`,
  });
});

function choose(choice: FormDataEntryValue | null, custom: FormDataEntryValue | null): bigint {
  const selected = String(choice ?? "").trim();
  if (selected !== "custom" && /^\d+$/.test(selected)) return BigInt(selected);
  return parsePriceInput(String(custom ?? ""));
}
