/**
 * app/_components/buy-bar.tsx — the price, pinned to the bottom of a phone.
 *
 * *Added 2026-08-30 on the founder's direction to take Gumroad's product page as the
 * shape.* On a phone the buy box is above the fold and then it is gone: a reader who
 * scrolls the README, the release log and the file tree has no price and no way to buy
 * without scrolling back up past all of it. This is the answer Gumroad has and we did
 * not — a bar that carries the price and the action, and appears exactly when the box
 * it duplicates has left the screen.
 *
 * Four decisions hold it inside this design system rather than beside it.
 *
 * 1. **It is a link to the box, not a second buy button.** The real control is
 *    `buy-with-wallet.tsx`, which holds wallet state, chain state and a `role="status"`
 *    region; a second instance of it would be two components disagreeing about which
 *    wallet is connected. This is an anchor to `#buy`, which works with scripting off,
 *    keeps the middle click, and lands the reader on the control that takes the money.
 * 2. **It never shares a screen with the buy box**, which is what keeps The One Order
 *    Line Rule intact: the accent as a ground appears once per page, and here it appears
 *    once per *viewport* because the bar is shown only while the box is out of view.
 * 3. **Phones only.** Above `60rem` the box is in a sticky right column and is never
 *    out of view, so the bar would be a duplicate of something already on screen.
 * 4. **Behaviour, so it may need script.** With scripting off it is not rendered at all
 *    — `[data-js="on"]` gates it — and the fallback is the page as it was this morning.
 *    Nothing in it is content: the price, the update price and the action are all in the
 *    server HTML already, sixty lines up, inside the box.
 *
 * The bar sits above the home indicator via `env(safe-area-inset-bottom)`, and the page
 * reserves its height as bottom padding so the last line of the document is never
 * underneath it.
 */

/**
 * One observer, inline, emitted with the bar. `rootMargin` fires the change a little
 * before the box actually leaves, so the bar is already there when it is wanted rather
 * than sliding in late.
 */
const SCRIPT = `document.documentElement.dataset.js="on";
(function(){var bar=document.querySelector("[data-buybar]"),box=document.getElementById("buy");
if(!bar||!box)return;
if(!("IntersectionObserver" in window)){bar.setAttribute("data-visible","");return}
new IntersectionObserver(function(e){
for(var i=0;i<e.length;i++)e[i].isIntersecting?bar.removeAttribute("data-visible"):bar.setAttribute("data-visible","")
},{rootMargin:"-8px 0px 0px 0px",threshold:0}).observe(box)})();`;

type Props = {
  /** Already formatted — `"$9.00"` or `"Free"`. Money is never formatted in a component. */
  price: string;
  /** `"new releases included"` or `"new releases $5.00"`. The second line, in Ash. */
  updates: string;
  /** False for a retired or unreleased listing, where there is nothing to jump to. */
  forSale: boolean;
};

export function BuyBar({ price, updates, forSale }: Props) {
  if (!forSale) return null;
  return (
    <>
      <div className="buybar" data-buybar aria-hidden="false">
        <p className="price">
          <strong>{price}</strong>
          <span className="updates">{updates}</span>
        </p>
        <a href="#buy" data-button="primary">
          Buy
          <span className="sr-only"> — go to the order block</span>
        </a>
      </div>
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
    </>
  );
}
