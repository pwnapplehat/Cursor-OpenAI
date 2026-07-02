import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAddressForUrl, getLanAddresses, isAllInterfacesHost, type NetworkAddress } from "../src/utils/networkAddresses";

test("isAllInterfacesHost recognizes the bind-everything hosts", () => {
  assert.equal(isAllInterfacesHost("0.0.0.0"), true);
  assert.equal(isAllInterfacesHost("::"), true);
  assert.equal(isAllInterfacesHost(""), true);
  assert.equal(isAllInterfacesHost("  0.0.0.0  "), true, "tolerates surrounding whitespace");
});

test("isAllInterfacesHost treats loopback/specific hosts as NOT all-interfaces", () => {
  assert.equal(isAllInterfacesHost("127.0.0.1"), false);
  assert.equal(isAllInterfacesHost("::1"), false);
  assert.equal(isAllInterfacesHost("192.168.1.10"), false);
  assert.equal(isAllInterfacesHost("localhost"), false);
});

test("formatAddressForUrl brackets IPv6 and leaves IPv4 bare", () => {
  const v4: NetworkAddress = { address: "192.168.1.10", family: "IPv4", iface: "eth0" };
  const v6: NetworkAddress = { address: "2001:db8::1", family: "IPv6", iface: "eth0" };
  assert.equal(formatAddressForUrl(v4), "192.168.1.10");
  assert.equal(formatAddressForUrl(v6), "[2001:db8::1]");
});

test("getLanAddresses returns only non-internal, non-link-local addresses, IPv4 first", () => {
  // Pure function over os.networkInterfaces(); we can't assert specific IPs on
  // an arbitrary CI host, but we can assert its invariants hold on whatever it
  // returns here.
  const addrs = getLanAddresses();
  for (const addr of addrs) {
    assert.ok(addr.address.length > 0);
    assert.ok(addr.family === "IPv4" || addr.family === "IPv6");
    assert.notEqual(addr.address, "127.0.0.1", "loopback must be excluded");
    assert.notEqual(addr.address, "::1", "loopback must be excluded");
    assert.equal(addr.address.toLowerCase().startsWith("fe80"), false, "link-local IPv6 must be excluded");
  }
  // Ordering invariant: no IPv4 may appear after any IPv6.
  const firstV6 = addrs.findIndex((a) => a.family === "IPv6");
  if (firstV6 !== -1) {
    assert.ok(addrs.slice(firstV6).every((a) => a.family === "IPv6"), "all IPv4 addresses must sort before IPv6");
  }
});
