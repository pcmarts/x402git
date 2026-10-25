import { cookies } from "next/headers";
import { NETWORK_CHAIN, NETWORK_COOKIE, NETWORK_NAME, networkFrom, type Network } from "@/lib/admin/network";

/** The network the operator picked in the admin nav; mainnet until they pick. */
export async function currentNetwork(): Promise<{ net: Network; chainId: number; name: string }> {
  const net = networkFrom((await cookies()).get(NETWORK_COOKIE)?.value);
  return { net, chainId: NETWORK_CHAIN[net], name: NETWORK_NAME[net] };
}
