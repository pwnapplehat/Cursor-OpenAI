import { networkInterfaces } from "node:os";

export interface NetworkAddress {
  address: string;
  family: "IPv4" | "IPv6";
  iface: string;
}

/** Hosts that mean "bind every interface" - i.e. the gateway is reachable from other devices, not just this machine. */
const ALL_INTERFACES_HOSTS = new Set(["0.0.0.0", "::", ""]);

/** True when `host` binds all interfaces (LAN/remote-reachable) rather than a single/loopback address. */
export function isAllInterfacesHost(host: string): boolean {
  return ALL_INTERFACES_HOSTS.has(host.trim());
}

/**
 * Non-internal (off-machine reachable) IP addresses of this host, IPv4 first
 * (that's what people actually type to reach a LAN service), then global
 * IPv6. Loopback and link-local IPv6 (`fe80::`) are excluded since neither is
 * useful for "open this URL from another device."
 *
 * `family` normalization handles both the Node string form (`"IPv4"`) and the
 * legacy numeric form (`4`) defensively, even though this project's Node
 * floor (>=22.13) always returns strings.
 */
export function getLanAddresses(): NetworkAddress[] {
  const result: NetworkAddress[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      // `family` is typed `string` in current @types/node ("IPv4"/"IPv6"),
      // but older Node returned the numeric 4/6 - coerce to string so both
      // shapes normalize identically without a types-vs-runtime mismatch.
      const raw = String(addr.family);
      const family: "IPv4" | "IPv6" | undefined = raw === "IPv4" || raw === "4" ? "IPv4" : raw === "IPv6" || raw === "6" ? "IPv6" : undefined;
      if (!family) continue;
      if (family === "IPv6" && addr.address.toLowerCase().startsWith("fe80")) continue;
      result.push({ address: addr.address, family, iface });
    }
  }
  return result.sort((a, b) => (a.family === b.family ? 0 : a.family === "IPv4" ? -1 : 1));
}

/** Formats an address as a browser/base-URL host, bracketing IPv6 (`http://[::1]:8787`). */
export function formatAddressForUrl(addr: NetworkAddress): string {
  return addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
}
