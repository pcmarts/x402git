"use client";

/**
 * app/_components/card-carousel.tsx — the featured row's phone rendition.
 *
 * On the founder's direction (2026-08-30): under 48rem the three cards stopped
 * stacking and became a rail you swipe, with the next card always showing at the
 * right edge so the reader knows there is more without being told. The swipe is
 * CSS scroll-snap on the `.cards` list itself — it works with JavaScript off —
 * and this component adds only what CSS cannot: the arrow pair and the `1 / 3`
 * position line under the rail. On desktop the same children render as the
 * three-up grid and the nav row does not display; this wrapper costs nothing.
 *
 * The children are the server-rendered `ListingCards`, passed through untouched,
 * so the cards stay in the server HTML (`npm run check:ssr`) and this file never
 * learns what a listing is.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

type CardCarouselProps = {
  /** How many cards ride the rail; the server knows, so the counter is in the HTML. */
  count: number;
  children: ReactNode;
};

export function CardCarousel({ count, children }: CardCarouselProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const rail = railRef.current?.querySelector<HTMLElement>(".cards");
    if (!rail || rail.children.length < 2) return;
    const first = rail.children[0] as HTMLElement;
    const second = rail.children[1] as HTMLElement;
    const onScroll = () => {
      const step = second.offsetLeft - first.offsetLeft;
      if (step <= 0) return;
      setIndex(Math.max(0, Math.min(count - 1, Math.round(rail.scrollLeft / step))));
    };
    rail.addEventListener("scroll", onScroll, { passive: true });
    return () => rail.removeEventListener("scroll", onScroll);
  }, [count]);

  // Snap to a neighbour. `block: "nearest"` keeps the page from scrolling
  // vertically; smoothness comes from the rail's own `scroll-behavior`, so
  // prefers-reduced-motion is honoured in one place, in the CSS.
  const go = (delta: number) => {
    const rail = railRef.current?.querySelector<HTMLElement>(".cards");
    const target = rail?.children[Math.max(0, Math.min(count - 1, index + delta))];
    target?.scrollIntoView({ block: "nearest", inline: "start" });
  };

  return (
    <div className="card-rail" ref={railRef}>
      {children}
      {count > 1 ? (
        <div className="rail-nav">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={index === 0}
            aria-label="Previous listing"
          >
            <Icon name="arrow-left" />
          </button>
          <span className="rail-count">
            {index + 1} / {count}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index === count - 1}
            aria-label="Next listing"
          >
            <Icon name="arrow-right" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
