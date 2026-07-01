import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { authMiddleware } from "../src/middleware/auth";
import { HttpError } from "../src/errors";
import { makeTestConfig } from "./helpers/testConfig";

function makeRequest(authorizationHeader: string | undefined): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorizationHeader : undefined),
  } as unknown as Request;
}

const fakeRes = {} as Response;

test("server mode with no AUTH_KEY configured: uses the server's own Cursor key regardless of the client's header", () => {
  const config = makeTestConfig({ cursorKeyMode: "server", cursorApiKey: "server-key", authKey: undefined });
  const req = makeRequest(undefined);
  let nextArg: unknown = "not-called";
  const next: NextFunction = (err?: unknown) => {
    nextArg = err;
  };

  authMiddleware(config)(req, fakeRes, next);

  assert.equal(nextArg, undefined, "next() should be called with no error");
  assert.equal(req.cursorApiKey, "server-key");
});

test("server mode with AUTH_KEY set: rejects requests with a missing or wrong bearer token", () => {
  const config = makeTestConfig({ cursorKeyMode: "server", cursorApiKey: "server-key", authKey: "secret-gateway-key" });

  let nextArg: unknown;
  authMiddleware(config)(makeRequest(undefined), fakeRes, (err) => (nextArg = err));
  assert.ok(nextArg instanceof HttpError);
  assert.equal((nextArg as HttpError).status, 401);

  nextArg = undefined;
  authMiddleware(config)(makeRequest("Bearer wrong-key"), fakeRes, (err) => (nextArg = err));
  assert.ok(nextArg instanceof HttpError);
  assert.equal((nextArg as HttpError).status, 401);
});

test("server mode with AUTH_KEY set: accepts a matching bearer token and still uses the server's own Cursor key", () => {
  const config = makeTestConfig({ cursorKeyMode: "server", cursorApiKey: "server-key", authKey: "secret-gateway-key" });
  const req = makeRequest("Bearer secret-gateway-key");
  let nextArg: unknown = "not-called";

  authMiddleware(config)(req, fakeRes, (err) => (nextArg = err));

  assert.equal(nextArg, undefined);
  assert.equal(req.cursorApiKey, "server-key", "the client's bearer token gates access but is never used as the Cursor key in server mode");
});

test("passthrough mode: rejects requests with no bearer token", () => {
  const config = makeTestConfig({ cursorKeyMode: "passthrough", cursorApiKey: undefined });
  let nextArg: unknown;

  authMiddleware(config)(makeRequest(undefined), fakeRes, (err) => (nextArg = err));

  assert.ok(nextArg instanceof HttpError);
  assert.equal((nextArg as HttpError).status, 401);
});

test("passthrough mode: uses the client's bearer token as the Cursor API key", () => {
  const config = makeTestConfig({ cursorKeyMode: "passthrough", cursorApiKey: undefined, authKey: "irrelevant-in-this-mode" });
  const req = makeRequest("Bearer crsr_client_supplied_key");
  let nextArg: unknown = "not-called";

  authMiddleware(config)(req, fakeRes, (err) => (nextArg = err));

  assert.equal(nextArg, undefined);
  assert.equal(req.cursorApiKey, "crsr_client_supplied_key");
});

test("bearer token parsing is case-insensitive on the \"Bearer\" scheme and trims whitespace", () => {
  const config = makeTestConfig({ cursorKeyMode: "passthrough" });
  const req = makeRequest("bearer   crsr_abc  ");
  let nextArg: unknown = "not-called";

  authMiddleware(config)(req, fakeRes, (err) => (nextArg = err));

  assert.equal(nextArg, undefined);
  assert.equal(req.cursorApiKey, "crsr_abc");
});
