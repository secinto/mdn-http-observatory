import { describe, it } from "node:test";

import { assert } from "chai";

import {
  InvalidHostNameError,
  ScanFailedError,
  SiteIsDownError,
  UnexpectedStatusCodeError,
} from "../src/api/errors.js";
import globalErrorHandler from "../src/api/global-error-handler.js";
import { ScanAbortReason, ScanAbortedError } from "../src/scanner/index.js";

describe("ScanFailedError", () => {
  /**
   * @type {{ label: string, cause: Error, statusCode: number }[]}
   */
  const cases = [
    {
      label: "an unreachable site",
      cause: new SiteIsDownError(),
      statusCode: 422,
    },
    {
      label: "an unexpected response status code",
      cause: new UnexpectedStatusCodeError(503),
      statusCode: 422,
    },
    {
      label: "an invalid hostname",
      cause: new InvalidHostNameError(),
      statusCode: 422,
    },
    {
      label: "an unexpected internal failure",
      cause: new Error("something broke"),
      statusCode: 500,
    },
  ];

  for (const { label, cause, statusCode } of cases) {
    it(`reports ${statusCode} for ${label}`, function () {
      const error = new ScanFailedError(cause);
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.name, "scan-failed");
      assert.equal(error.message, cause.message);
    });
  }
});

/** Minimal stand-in for a Fastify reply that records status and body. */
class FakeReply {
  /** @type {number | undefined} */
  statusCode;
  /** @type {any} */
  body;

  /** @param {number} code */
  status(code) {
    this.statusCode = code;
    return this;
  }

  /** @param {any} body */
  send(body) {
    this.body = body;
    return this;
  }
}

describe("globalErrorHandler", () => {
  it("adds the not-scanned reason and site status code to an aborted scan", async function () {
    const reply = new FakeReply();
    const cause = new ScanAbortedError(
      "Site is protected by HTTP authentication and serves no content to grade.",
      ScanAbortReason.HTTP_AUTH,
      401
    );
    await globalErrorHandler(
      /** @type {any} */ (new ScanFailedError(cause)),
      /** @type {any} */ ({}),
      /** @type {any} */ (reply)
    );
    assert.equal(reply.statusCode, 422);
    assert.deepEqual(reply.body, {
      error: "scan-failed",
      message: cause.message,
      not_scanned_reason: "http-auth",
      status_code: 401,
    });
  });

  it("keeps the upstream body for other application errors", async function () {
    const reply = new FakeReply();
    await globalErrorHandler(
      /** @type {any} */ (new InvalidHostNameError()),
      /** @type {any} */ ({}),
      /** @type {any} */ (reply)
    );
    assert.equal(reply.statusCode, 422);
    assert.deepEqual(reply.body, {
      error: "invalid-hostname",
      message: "Invalid hostname",
    });
  });
});
