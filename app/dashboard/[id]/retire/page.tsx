/**
 * GET /dashboard/:id/retire — the confirmation, as a page.
 *
 * Not a dialog. A `confirm()` does not exist with JavaScript off, and this is the one
 * irreversible thing a creator can do from the dashboard: the slug is never reused and
 * there is no un-retire. A page can state the consequences at length, which a modal
 * cannot, and typing the slug is a deliberate act rather than a reflex click.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Notice } from "@/app/_components/notice";
import { requireDashboard } from "@/lib/web/dashboard";
import { loadListingById } from "@/lib/web/loaders";

export const metadata: Metadata = { title: "Stop selling" };
export const dynamic = "force-dynamic";

export default async function RetirePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { creator } = await requireDashboard(`/dashboard/${id}/retire`);

  const bundle = await loadListingById(id);
  if (!bundle || bundle.creator.id !== creator.id) notFound();
  if (bundle.status === "retired") {
    return (
      <main>
        <h1>Already retired</h1>
        <p className="written measure">
          {creator.handle}/{bundle.listing.slug} is no longer sold. <a href={`/dashboard/${id}`}>Back to the listing</a>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>
        Stop selling {creator.handle}/{bundle.listing.slug}?
      </h1>
      <Notice error={error} />

      <p className="written measure">This cannot be undone. After it goes through:</p>
      <ul className="written measure">
        <li>No new purchases. The resource endpoint answers 410 to anyone who does not already own a version.</li>
        <li>
          Everyone who has already bought keeps every version they own, forever, and can still fetch it. A buyer never loses a purchase
          to a seller&rsquo;s action.
        </li>
        <li>The manifest page and the release log stay up, marked no longer sold.</li>
        <li>
          The slug <span className="computed">{bundle.listing.slug}</span> is retired with it and cannot be used again, by you or by
          anyone.
        </li>
        <li>Earnings already made are unaffected and still sweep on the normal schedule.</li>
      </ul>

      <form method="post" action={`/dashboard/${id}/actions/retire`}>
        <input type="hidden" name="slug" value={bundle.listing.slug} />
        <div className="field">
          <label htmlFor="confirm">Type {bundle.listing.slug} to confirm</label>
          <input id="confirm" name="confirm" required autoComplete="off" spellCheck={false} />
        </div>
        <p className="actions">
          <button type="submit">Retire it</button>
          <a href={`/dashboard/${id}`}>Keep selling</a>
        </p>
      </form>
    </main>
  );
}
