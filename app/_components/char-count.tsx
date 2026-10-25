"use client";

/**
 * app/_components/char-count.tsx — what is left of a field's budget.
 *
 * The two self-reported fields have tight ceilings (`DESCRIPTION_LIMIT`,
 * `TRIGGER_HINT_LIMIT`), and a ceiling a creator only discovers by hitting it is a
 * ceiling that reads as a bug. This counts down inside the box, bottom right (2026-09-01,
 * founder — it was beside the label until then), and goes to Fail Red and "N over" once
 * the budget is spent.
 *
 * Three states, not two. Ash while there is room; Warn Amber over the last tenth of the
 * budget, on the count alone; Fail Red once it is spent, on the count *and* the field —
 * value, caret and border — so that at the point something is actually wrong it is the
 * thing that is wrong that is coloured, not only the number describing it.
 *
 * The limit is **soft on the client and hard on the server**, deliberately. A `maxLength`
 * would be simpler and is what a form usually reaches for, but it swallows the end of a
 * paste without saying so — the creator gets a sentence that stops mid-word and no
 * explanation. Instead the field takes the whole text, says how far over it is, marks
 * itself invalid, and `actions/save` refuses the POST by naming the field and the
 * overage. Nothing is ever silently truncated.
 *
 * Renders nothing before mount, and a count of what is left in a control nobody has typed
 * into yet is not a fact about the listing anyway.
 *
 * That leaves a reader with scripting off no statement of the limit at all — the field
 * help that used to carry it was removed on 2026-09-01 (founder), and this is the one
 * thing that went with it. It is a soft edge, not a broken one: `actions/save` refuses an
 * over-length POST by naming the field and the overage, so the ceiling is still stated at
 * the moment it is reached, just not before. Worth a line in the field's own markup if
 * the no-script path ever gets a second look.
 */

import { useEffect, useState } from "react";

/**
 * Where the amber starts: a tenth of the budget, floored at ten characters, so it is
 * proportionate on both fields rather than a magic 20 that means "nearly there" on the
 * 200 and "you have barely begun" on the 120.
 */
function nearAt(limit: number): number {
  return Math.max(10, Math.round(limit * 0.1));
}

export function CharCount({ htmlFor, limit }: { htmlFor: string; limit: number }) {
  const [used, setUsed] = useState<number | null>(null);

  useEffect(() => {
    const field = document.getElementById(htmlFor);
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return;

    const read = () => {
      const length = field.value.length;
      setUsed(length);

      // Two attributes doing two jobs, and both only on the breach. `data-limit` is
      // presentation — it turns the value and the caret red — and `aria-invalid` is the
      // assistive-technology signal, which also brings the system's red border with it.
      //
      // Neither fires on the approach. The count above goes amber over the last tenth of
      // the budget, and that is the whole of the early warning: a box that changed colour
      // under somebody mid-sentence would be a field crying wolf at 90%.
      if (length > limit) {
        field.setAttribute("data-limit", "over");
        field.setAttribute("aria-invalid", "true");
      } else {
        field.removeAttribute("data-limit");
        field.removeAttribute("aria-invalid");
      }
    };

    read();
    field.addEventListener("input", read);
    return () => {
      field.removeEventListener("input", read);
      field.removeAttribute("data-limit");
      field.removeAttribute("aria-invalid");
    };
  }, [htmlFor, limit]);

  if (used === null) return null;

  const left = limit - used;
  const status = left < 0 ? "fail" : left <= nearAt(limit) ? "warn" : undefined;
  return (
    <span className="count" data-status={status}>
      {left < 0 ? `${-left} over` : `${left} left`}
    </span>
  );
}
