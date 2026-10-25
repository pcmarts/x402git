/**
 * app/_components/save-bar.tsx — Save and Publish, pinned once they scroll away.
 *
 * The same shape as `buy-bar.tsx` and for the same reason: the controls live in the
 * right column, and a creator four screens down a listing they have been editing has no
 * way to commit it without scrolling back past everything. An IntersectionObserver
 * watches the real controls and reveals this bar exactly when they leave the screen.
 *
 * What keeps it inside the design system rather than beside it:
 *
 * - **These are the same buttons, not second copies.** Both carry `form=`, which is how
 *   HTML associates a control with a form it is not inside — so there is one price form
 *   and one publish form on the page, each with two triggers, and no state to disagree
 *   about. It works with scripting off, except that with scripting off the bar is never
 *   shown at all.
 * - **The accent ground is still once per viewport.** Whichever control is the page's
 *   order line — Publish on a draft, Save changes once the listing is live — wears it in
 *   the column and in the bar, and the bar exists only while the column's copy is off
 *   screen. That is the One Order Line Rule read per screen, which is how the buy bar
 *   earns it too. Never both: the two are mutually exclusive by construction, since
 *   `publishFormId` is null in exactly the state where `saveIsPrimary` is true.
 * - **Nothing in it is content.** Every word here is already in the server HTML above.
 *   `[data-js="on"]` gates it, so a reader without script gets the page as it was.
 *
 * The bar clears the home indicator with `env(safe-area-inset-bottom)`, and the footer
 * reserves its height so the last line of the document is never underneath it.
 */

/** One observer, inline, emitted with the bar. */
const SCRIPT = `document.documentElement.dataset.js="on";
(function(){var bar=document.querySelector("[data-savebar]"),anchor=document.getElementById("listing-actions");
if(!bar||!anchor||!("IntersectionObserver" in window))return;
new IntersectionObserver(function(e){
for(var i=0;i<e.length;i++)e[i].isIntersecting?bar.removeAttribute("data-visible"):bar.setAttribute("data-visible","")
},{rootMargin:"0px",threshold:0}).observe(anchor)})();`;

type Props = {
  /** `handle/slug`, so a pinned bar says which listing it is about to write to. */
  reference: string;
  /** The `id` of the form Save submits. */
  formId: string;
  /** The `id` of the publish form, or null when the listing is live or retired. */
  publishFormId: string | null;
  /** FR-42's gates are not all passing yet. */
  blocked: boolean;
  /**
   * Save wears the accent instead of Publish. True only on a live listing, where there
   * is no Publish left and committing an edit is the one act the page is for. The page
   * decides; the bar is a second trigger for the same buttons and never a second opinion
   * about which of them is the order line.
   */
  saveIsPrimary: boolean;
};

export function SaveBar({ reference, formId, publishFormId, blocked, saveIsPrimary }: Props) {
  return (
    <>
      <div className="savebar" data-savebar>
        <p className="what computed">{reference}</p>
        <span className="controls">
          <button type="submit" form={formId} data-variant={saveIsPrimary ? "primary" : undefined}>
            Save changes
          </button>
          {publishFormId ? (
            <button type="submit" form={publishFormId} data-variant="primary" disabled={blocked}>
              Publish
            </button>
          ) : null}
        </span>
      </div>
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
    </>
  );
}
