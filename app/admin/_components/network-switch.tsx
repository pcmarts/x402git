"use client";

/**
 * The network switch in the admin nav. Two buttons in one POST form, so it works with
 * scripting off; the route sets the cookie and sends the operator back where they were.
 * A client component only for `usePathname`, which also renders on the server.
 */

import { usePathname } from "next/navigation";
import type { Network } from "@/lib/admin/network";

export function NetworkSwitch({ net }: { net: Network }) {
  const pathname = usePathname() ?? "/admin";
  return (
    <form method="post" action="/admin/network" className="netswitch" aria-label="Network">
      <input type="hidden" name="back" value={pathname} />
      <button type="submit" name="net" value="mainnet" aria-pressed={net === "mainnet"}>
        Mainnet
      </button>
      <button type="submit" name="net" value="testnet" aria-pressed={net === "testnet"}>
        Testnet
      </button>
    </form>
  );
}
