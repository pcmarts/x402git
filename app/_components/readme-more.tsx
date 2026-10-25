/**
 * app/_components/readme-more.tsx — the README, previewed rather than hidden.
 *
 * Three versions of this section have shipped in one day, and the third is the founder's:
 *
 *   1. The README *was* the page. The price was two thousand words below it.
 *   2. Then it was a closed `<details>` with a one-line teaser — which fixed the price
 *      and broke the README: a reader could no longer see what they were buying without
 *      a click, and the opening paragraphs of a README are the best sales copy on the
 *      page because the creator wrote them for a reader, not for a buyer.
 *   3. Now: the first screenful renders, clipped, fading into the paper, with one
 *      control that opens the rest. Read without clicking; open if you want to.
 *
 * Progressive enhancement, the same way `buy-bar.tsx` does it, and for the same
 * reason: **the whole README is always in the server HTML**, unclipped and unhidden.
 * `npm run check:ssr` proves it and an agent reading this page with `curl` gets the
 * complete document. The clip and the control are behaviour, and behaviour is the only
 * thing on this page allowed to need script.
 *
 * With scripting off there is no clip and no button — the README is simply the README,
 * long. That is the honest fallback: the point was never the fold, it was that the
 * price is not underneath one.
 *
 * The control is a real `<button>` and never renders as a dead one: it is `display:
 * none` in CSS until the inline script sets `<html data-js="on">`, and the same script
 * measures the block and removes both the clip and the control when the README already
 * fits. A "Show more" on a six-line README is a lie about how much is left.
 */

import { Icon } from "@/app/_components/icons";

const READMEID = "readme-body";

/**
 * The trust report's clipped body. Exported because two files name it: the section that
 * clips it and the link in the buy column that opens it (`data-readme-open`), and an id
 * those two spell differently is a link that quietly stops working.
 */
export const TRUST_BODY_ID = "trust-body";

/**
 * One delegated listener, inline. An inline `<script>` rather than a client component
 * because a disclosure is not worth a hydration boundary. It is generic over every
 * `data-readme-toggle` button on the page — the README and, since 14 Sep 2026, the trust
 * report — so the page emits it exactly once, via `<ClipScript />`, after the last
 * clipped section. Twice would register two click listeners and every press would toggle
 * twice, visibly doing nothing.
 *
 * `set` is the whole of the behaviour and there are two ways into it:
 *
 * - the section's own control, which flips it;
 * - anything carrying `data-readme-open="<id>"`, which only ever opens it (14 Sep 2026,
 *   on the founder's direction: *"when a user clicks Show report on the right panel, can
 *   this also expand the trust report on the main page"*). It is a plain anchor to the
 *   section, so with scripting off it still lands on an unclipped report; with scripting
 *   on the section is open by the time the browser jumps to it, in the same tick.
 *
 * A link like that never *closes* anything — a reader who has just asked to see a thing
 * does not want the second click to have hidden it — and it does nothing at all when the
 * section already fits, because `fit` will have taken the clip and the control off it and
 * "Show less" over a report with nothing folded is a control that lies about its own
 * state.
 */
const SCRIPT = `document.documentElement.dataset.js="on";
(function(){
function set(t,open){var r=document.getElementById(t.getAttribute("aria-controls"));if(!r)return;
t.setAttribute("aria-expanded",open?"true":"false");
t.textContent=open?"Show less":"Show more";
r.toggleAttribute("data-readme-clip",!open);
if(!open)r.scrollIntoView({block:"nearest"})}
function fit(){var b=document.querySelectorAll("button[data-readme-toggle]");
for(var i=0;i<b.length;i++){var t=b[i],r=document.getElementById(t.getAttribute("aria-controls"));
if(!r||t.getAttribute("aria-expanded")==="true")continue;
var c=r.scrollHeight<=r.clientHeight+8;r.toggleAttribute("data-readme-clip",!c);
if(t.parentNode)t.parentNode.hidden=c}}
fit();addEventListener("load",fit);
document.addEventListener("click",function(e){
var o=e.target.closest?e.target.closest("[data-readme-open]"):null;
if(o){var i=o.getAttribute("data-readme-open"),r=document.getElementById(i);
var g=document.querySelector('button[data-readme-toggle][aria-controls="'+i+'"]');
if(g&&r&&r.hasAttribute("data-readme-clip"))set(g,true);return}
var t=e.target.closest?e.target.closest("button[data-readme-toggle]"):null;if(!t)return;
set(t,t.getAttribute("aria-expanded")!=="true")});
})();`;

/**
 * `html` is the analyser's rendered markdown, sanitised there and again by
 * `sanitiseHtml` before it reaches this component. The `.written` face marks it as the
 * creator's prose rather than a computed field (DESIGN.md, The Computed / Written Rule).
 */
export function ReadmeSection({ html }: { html: string }) {
  return (
    <section className="readme">
      <h2>
        <Icon name="book" />
        README
      </h2>
      <div id={READMEID} className="readme-body written" data-readme-clip dangerouslySetInnerHTML={{ __html: html }} />
      <ClipToggle id={READMEID} />
    </section>
  );
}

/**
 * The control under a clipped block, for any section that borrows the clip.
 *
 * It is `display: none` until the inline script sets `<html data-js="on">` and `fit`
 * hides it again when the block it controls already fits, so it never renders as a dead
 * button and never offers to reveal nothing. The label is the only state it carries and
 * `set` above owns it, which is why it is text and not two spans: the README's own
 * disclosures swap labels in CSS, but this one is written to by script either way.
 */
export function ClipToggle({ id }: { id: string }) {
  return (
    <p className="readme-more">
      <button type="button" data-readme-toggle aria-expanded="false" aria-controls={id}>
        Show more
      </button>
    </p>
  );
}

/** The clip behaviour, once per page — see the note on SCRIPT. */
export function ClipScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
