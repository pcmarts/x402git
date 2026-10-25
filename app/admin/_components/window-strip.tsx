/**
 * The time window control the money and activity pages share.
 *
 * The filter strip's shape, because it is the same kind of control: a ruled line of
 * links in the Label face with the current one in Ink, and the state lives in the URL
 * so a window survives a reload and can be pasted to somebody else. No script.
 *
 * A private `_components` folder: Next does not route it.
 */

import { WINDOW_LABEL, WINDOWS, type AdminWindow } from "@/lib/admin/window";

export function WindowStrip({ current, base }: { current: AdminWindow; base: string }) {
  return (
    <nav className="filters" aria-label="Time window">
      {WINDOWS.map((name) => (
        <a key={name} href={name === "all" ? base : `${base}?window=${name}`} aria-current={current === name ? "page" : undefined}>
          {WINDOW_LABEL[name]}
        </a>
      ))}
    </nav>
  );
}
