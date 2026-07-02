import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { loopbackOnlyMiddleware } from "../src/middleware/loopbackOnly";
import { HttpError } from "../src/errors";
import { makeTestConfig } from "./helpers/testConfig";

function makeRequest(ip: string | undefined, remoteAddress: string | undefined, headers: Record<string, string> = {}): Request {
  return { ip, socket: { remoteAddress }, headers } as unknown as Request;
}

const fakeRes = {} as Response;

test("loopbackOnlyMiddleware allows 127.0.0.1", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown = "not-called";
  loopbackOnlyMiddleware(config)(makeRequest("127.0.0.1", "127.0.0.1"), fakeRes, (err) => (nextArg = err));
  assert.equal(nextArg, undefined);
});

test("loopbackOnlyMiddleware allows ::1", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown = "not-called";
  loopbackOnlyMiddleware(config)(makeRequest("::1", "::1"), fakeRes, (err) => (nextArg = err));
  assert.equal(nextArg, undefined);
});

test("loopbackOnlyMiddleware rejects a remote IP by default", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown;
  loopbackOnlyMiddleware(config)(makeRequest("203.0.113.5", "203.0.113.5"), fakeRes, (err) => (nextArg = err));
  assert.ok(nextArg instanceof HttpError);
  assert.equal((nextArg as HttpError).status, 401);
});

test("loopbackOnlyMiddleware allows remote IPs when adminAllowRemote is true", () => {
  const config = makeTestConfig({ adminAllowRemote: true });
  let nextArg: unknown = "not-called";
  loopbackOnlyMiddleware(config)(makeRequest("203.0.113.5", "203.0.113.5"), fakeRes, (err) => (nextArg = err));
  assert.equal(nextArg, undefined);
});

test("loopbackOnlyMiddleware falls back to socket.remoteAddress when req.ip is undefined", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown = "not-called";
  loopbackOnlyMiddleware(config)(makeRequest(undefined, "127.0.0.1"), fakeRes, (err) => (nextArg = err));
  assert.equal(nextArg, undefined);
});

test("loopbackOnlyMiddleware rejects a loopback request that arrived via a proxy/tunnel (X-Forwarded-For)", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown;
  loopbackOnlyMiddleware(config)(makeRequest("127.0.0.1", "127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), fakeRes, (err) => (nextArg = err));
  assert.ok(nextArg instanceof HttpError, "a tunnel-forwarded request must not be treated as local");
  assert.equal((nextArg as HttpError).status, 401);
});

test("loopbackOnlyMiddleware rejects a loopback request forwarded by Cloudflare (cf-connecting-ip)", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown;
  loopbackOnlyMiddleware(config)(makeRequest("127.0.0.1", "127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }), fakeRes, (err) => (nextArg = err));
  assert.ok(nextArg instanceof HttpError);
});

test("loopbackOnlyMiddleware still allows a genuinely local request (loopback, no forwarding headers)", () => {
  const config = makeTestConfig({ adminAllowRemote: false });
  let nextArg: unknown = "not-called";
  loopbackOnlyMiddleware(config)(makeRequest("127.0.0.1", "127.0.0.1", {}), fakeRes, (err) => (nextArg = err));
  assert.equal(nextArg, undefined);
});

test("loopbackOnlyMiddleware with adminAllowRemote=true ignores forwarding headers entirely", () => {
  const config = makeTestConfig({ adminAllowRemote: true });
  let nextArg: unknown = "not-called";
  loopbackOnlyMiddleware(config)(makeRequest("203.0.113.9", "203.0.113.9", { "x-forwarded-for": "203.0.113.9" }), fakeRes, (err) => (nextArg = err));
  assert.equal(nextArg, undefined);
});
