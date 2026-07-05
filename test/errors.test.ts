import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentBusyError,
  AgentNotFoundError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  RateLimitError,
  UnknownAgentError,
} from "@cursor/sdk";
import { HttpError, mapErrorToResponse } from "../src/errors";

test("HttpError static factories set the expected status/type/code", () => {
  assert.equal(HttpError.badRequest("bad").status, 400);
  assert.equal(HttpError.unauthorized("no key").status, 401);
  assert.equal(HttpError.notFound("missing").status, 404);
  assert.equal(HttpError.notImplemented("nope").status, 501);
  assert.equal(HttpError.tooManyRequests("slow down").status, 429);
  assert.equal(HttpError.internal("oops").status, 500);
  assert.equal(HttpError.timeout("too slow").status, 504);
  assert.equal(HttpError.badRequest("bad", "model").param, "model");
});

test("mapErrorToResponse passes an HttpError's own status/type/code/param straight through", () => {
  const mapped = mapErrorToResponse(HttpError.badRequest("bad model", "model"));
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error.message, "bad model");
  assert.equal(mapped.body.error.type, "invalid_request_error");
  assert.equal(mapped.body.error.param, "model");
  assert.equal(mapped.logLevel, "warn");
});

test("mapErrorToResponse marks 5xx HttpErrors for error-level logging and 4xx for warn-level", () => {
  assert.equal(mapErrorToResponse(HttpError.internal("boom")).logLevel, "error");
  assert.equal(mapErrorToResponse(HttpError.badRequest("bad")).logLevel, "warn");
});

test("mapErrorToResponse maps AuthenticationError to 401", () => {
  const mapped = mapErrorToResponse(new AuthenticationError("invalid key"));
  assert.equal(mapped.status, 401);
  assert.equal(mapped.body.error.message, "invalid key");
});

test("mapErrorToResponse maps RateLimitError to 429", () => {
  const mapped = mapErrorToResponse(new RateLimitError("slow down"));
  assert.equal(mapped.status, 429);
  assert.equal(mapped.body.error.type, "rate_limit_error");
});

test("mapErrorToResponse maps AgentBusyError to 409", () => {
  const mapped = mapErrorToResponse(new AgentBusyError("agent is busy"));
  assert.equal(mapped.status, 409);
});

test("mapErrorToResponse maps AgentNotFoundError to 404", () => {
  const mapped = mapErrorToResponse(new AgentNotFoundError("no such agent"));
  assert.equal(mapped.status, 404);
});

test("mapErrorToResponse maps ConfigurationError to 400", () => {
  const mapped = mapErrorToResponse(new ConfigurationError("bad config"));
  assert.equal(mapped.status, 400);
});

test("mapErrorToResponse maps NetworkError to 503", () => {
  const mapped = mapErrorToResponse(new NetworkError("upstream down"));
  assert.equal(mapped.status, 503);
});

test("mapErrorToResponse maps UnknownAgentError to 500", () => {
  const mapped = mapErrorToResponse(new UnknownAgentError("???"));
  assert.equal(mapped.status, 500);
});

test("mapErrorToResponse honors an explicit status on the Cursor error over the class default", () => {
  const mapped = mapErrorToResponse(new AuthenticationError("weird case", { status: 418 }));
  assert.equal(mapped.status, 418);
});

test("mapErrorToResponse surfaces isRetryable from Cursor SDK errors", () => {
  const mapped = mapErrorToResponse(new NetworkError("timeout", { isRetryable: true }));
  assert.equal(mapped.isRetryable, true);
});

test("mapErrorToResponse maps body-parser's 413 PayloadTooLargeError to a real 413 (not 500)", () => {
  // Faithful shape of what express.json({ limit }) throws via raw-body /
  // http-errors: message "request entity too large", status+statusCode 413,
  // expose true, type "entity.too.large". Clients like Hermes key their
  // payload-compression recovery on the 413 status specifically.
  const err = Object.assign(new Error("request entity too large"), {
    status: 413,
    statusCode: 413,
    expose: true,
    type: "entity.too.large",
  });
  const mapped = mapErrorToResponse(err);
  assert.equal(mapped.status, 413);
  assert.equal(mapped.body.error.type, "invalid_request_error");
  assert.equal(mapped.body.error.code, "entity_too_large");
  assert.equal(mapped.body.error.message, "request entity too large");
  assert.equal(mapped.logLevel, "warn");
});

test("mapErrorToResponse maps body-parser's 400 parse failure to a 400", () => {
  const err = Object.assign(new Error("Unexpected token < in JSON"), {
    status: 400,
    statusCode: 400,
    expose: true,
    type: "entity.parse.failed",
  });
  const mapped = mapErrorToResponse(err);
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error.code, "entity_parse_failed");
});

test("mapErrorToResponse does NOT treat non-exposed or 5xx status-bearing errors as client errors", () => {
  // expose !== true -> internal detail, stays a generic 500.
  const notExposed = Object.assign(new Error("internal thing"), { status: 413, expose: false });
  assert.equal(mapErrorToResponse(notExposed).status, 500);

  // 5xx status on a plain Error -> generic 500 branch, not the client-error branch.
  const serverStatus = Object.assign(new Error("upstream blew up"), { status: 502, expose: true });
  assert.equal(mapErrorToResponse(serverStatus).status, 500);
});

test("mapErrorToResponse falls back to a generic 500 for plain Error instances", () => {
  const mapped = mapErrorToResponse(new Error("something broke"));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.body.error.message, "something broke");
  assert.equal(mapped.body.error.type, "server_error");
});

test("mapErrorToResponse handles non-Error thrown values without crashing", () => {
  const mapped = mapErrorToResponse("just a string");
  assert.equal(mapped.status, 500);
  assert.equal(mapped.body.error.message, "An unknown error occurred.");

  const mappedUndefined = mapErrorToResponse(undefined);
  assert.equal(mappedUndefined.status, 500);
});
