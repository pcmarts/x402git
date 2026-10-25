/**
 * What leaves the browser for Vercel Web Analytics: no private surface, and no query
 * string except the listing reading and campaign tags.
 */

import { describe, expect, it } from "vitest";
import { beforeSend, trackedProps } from "@/app/_components/analytics";

describe("trackedProps", () => {
  it("turns data-track-* into properties and ignores the event name itself", () => {
    expect(trackedProps({ track: "sign_in_started", trackFrom: "signin" })).toEqual({ from: "signin" });
    expect(trackedProps({ track: "agent_reading_opened" })).toBeUndefined();
  });

  it("keeps two properties at most, Vercel Pro's limit", () => {
    expect(Object.keys(trackedProps({ track: "x", trackA: "1", trackB: "2", trackC: "3" }) ?? {})).toHaveLength(2);
  });
});

const pageview = (url: string) => ({ type: "pageview" as const, url });

describe("beforeSend", () => {
  it("drops admin and dashboard pages entirely", () => {
    expect(beforeSend(pageview("https://x402git.com/admin"))).toBeNull();
    expect(beforeSend(pageview("https://x402git.com/admin/listings?q=0xabc"))).toBeNull();
    expect(beforeSend(pageview("https://x402git.com/dashboard/earnings?ok=Saved"))).toBeNull();
  });

  it("does not mistake a creator whose handle starts with admin for the admin section", () => {
    expect(beforeSend(pageview("https://x402git.com/administrator/tool"))?.url).toBe("https://x402git.com/administrator/tool");
  });

  it("keeps the listing reading and utm tags, and strips everything else", () => {
    const out = beforeSend(pageview("https://x402git.com/examples/humanizer?view=agent&utm_source=x&error=boom&q=0xabc#readme"));
    expect(out?.url).toBe("https://x402git.com/examples/humanizer?view=agent&utm_source=x");
  });

  it("drops a view value that is not one of the two readings", () => {
    expect(beforeSend(pageview("https://x402git.com/examples/humanizer?view=<script>"))?.url).toBe("https://x402git.com/examples/humanizer");
  });
});
