import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "./layout";

/**
 * The link-unfurl image for every page that does not set its own. One sheet of paper,
 * one ink, monospace — the design system's tokens, in raster form (DESIGN.md).
 *
 * *Amended 2026-09-01, founder.* It carried the old pitch ("Sell access to any private
 * GitHub repo with x402") long after the home page stopped making it, so the card a
 * link produced and the page behind it opened on two different sentences. The headline
 * is now the hero's, read from `SITE_TAGLINE` rather than typed again, and the last
 * line is the hero's CTA — **Start selling** — drawn as the button it actually is, on
 * the same GitHub ground the page uses. What left is the raw `402 PAYMENT-REQUIRED`
 * line: it was the most interesting thing on the card to an agent's operator and the
 * least legible to the creator this page is written for, and a red-flag status code is
 * a poor last impression in a feed. It is still on `/docs`, in front of the reader it
 * is for.
 */
export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#f7f7f5",
          color: "#1a1a1a",
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        }}
      >
        <div style={{ display: "flex", fontSize: 36, borderBottom: "2px solid #1a1a1a", paddingBottom: 24 }}>{SITE_NAME}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {/* The hero's own line, at the hero's own weight, broken where the sense
              breaks rather than where 1200px happens to run out — "…for your / code."
              stranded the object of the sentence on a line of its own. */}
          <div style={{ display: "flex", flexDirection: "column", fontSize: 72, fontWeight: 700, lineHeight: 1.12, letterSpacing: "-0.02em" }}>
            <div style={{ display: "flex" }}>Get paid by agents</div>
            <div style={{ display: "flex" }}>for your code.</div>
          </div>
          {/* The hero's two lines, stacked the way the hero stacks them. Satori has no
              <br>, so the break is a second div — same as the headline above. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 30, color: "#6b6b6b" }}>
            <div style={{ display: "flex" }}>Your x402 page, live in a minute.</div>
            <div style={{ display: "flex" }}>Syncs with GitHub. Paid in USDC every time you ship.</div>
          </div>
        </div>
        {/* The call to action, drawn as the control it is on the page: GitHub ground,
            paper text, square. A card is not clickable, so this is a picture of the
            next step rather than a link — which is exactly what the button on the
            other side of the click says. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              background: "#24292f",
              color: "#f7f7f5",
              fontSize: 30,
              fontWeight: 500,
              padding: "18px 32px",
            }}
          >
            {/* The Octocat, drawn at the label's cap height in the label's colour —
                the same citation the page's button carries, because the click it
                stands for is a round trip to github.com. */}
            <svg width="34" height="34" viewBox="0 0 16 16" fill="#f7f7f5">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            Start selling
          </div>
          {/* The two facts that make the offer concrete, in the computed face and the
              muted ink: what the buyer pays in, and what the creator keeps. */}
          <div style={{ display: "flex", fontSize: 26, color: "#6b6b6b" }}>Paid in USDC · you keep 90%</div>
        </div>
      </div>
    ),
    size,
  );
}
