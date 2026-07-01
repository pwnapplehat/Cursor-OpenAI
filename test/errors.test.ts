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
