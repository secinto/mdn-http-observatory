import { describe, it } from "node:test";

import { assert } from "chai";

import { AppError } from "../src/api/errors.js";
import {
  ScanAbortReason,
  ScanAbortedError,
  analyzeScan,
  scan,
} from "../src/scanner/index.js";
import { Site } from "../src/site.js";

import { emptyRequests, fixtureRequests, scanWithRequests } from "./helpers.js";

/** @typedef {import("../src/scanner/index.js").ScanResult} ScanResult */

/** @param {number} status */
const requestsWithStatus = (status) => {
  const req = emptyRequests();
  if (req.responses.auto) {
    req.responses.auto.status = status;
  }
  return req;
};

/**
 * @param {number} status
 * @param {string} wwwAuth
 */
const requestsWithAuth = (status, wwwAuth) => {
  const req = requestsWithStatus(status);
  req.responses.auto?.headers.set("www-authenticate", wwwAuth);
  return req;
};

describe("Scanner", () => {
  it("returns an error on an unknown host", async function () {
    const domain =
      Array.from({ length: 223 })
        .fill(0)
        .map(() => String.fromCodePoint(Math.floor(Math.random() * 26) + 97))
        .join("") + ".net";
    const site = Site.fromSiteString(domain);
    try {
      await scan(site);
      throw new Error("scan should throw");
    } catch (error) {
      if (error instanceof AppError) {
        // Our fork appends the connection error detail to the message.
        assert.match(error.message, /^The site seems to be down\./);
        assert.equal(error.statusCode, 422);
      } else {
        throw new Error("Unexpected error type", { cause: error });
      }
    }
  });

  describe("reports unusable sites as unprocessable", () => {
    /**
     * @type {{ label: string, status: number | null, name: string, message: string }[]}
     */
    const cases = [
      {
        label: "no response at all",
        status: null,
        name: "site-down",
        message: "The site seems to be down.",
      },
      // Our fork grades 400, so it is not in this list (see status code gating).
      ...[100, 404, 500].map((status) => ({
        label: `a ${status} response`,
        status,
        name: "unexpected-status-code",
        message: `Site did respond with an unexpected HTTP status code ${status}.`,
      })),
    ];

    for (const { label, status, name, message } of cases) {
      it(label, function () {
        const requests = emptyRequests();
        if (status === null) {
          requests.responses.auto = null;
        } else {
          assert(requests.responses.auto);
          requests.responses.auto.status = status;
        }

        try {
          analyzeScan(requests);
          throw new Error("analyzeScan should throw");
        } catch (error) {
          if (error instanceof AppError) {
            assert.equal(error.name, name);
            assert.equal(error.message, message);
            assert.equal(error.statusCode, 422);
          } else {
            throw new Error("Unexpected error type", { cause: error });
          }
        }
      });
    }
  });

  it("returns expected results on observatory.mozilla.org", function () {
    const requests = fixtureRequests("observatory-mozilla-org");
    const scanResult = scanWithRequests(requests);

    assert.equal(scanResult.scan.algorithmVersion, 6);
    assert.equal(scanResult.scan.grade, "A+");
    assert.equal(scanResult.scan.score, 110);
    assert.equal(scanResult.scan.testsFailed, 0);
    assert.equal(scanResult.scan.testsPassed, 12);
    assert.equal(scanResult.scan.testsQuantity, 12);
    assert.equal(scanResult.scan.statusCode, 200);
    assert.equal(scanResult.scan.responseHeaders["content-type"], "text/html");
  });

  it("returns expected results on mozilla.org", function () {
    const requests = fixtureRequests("mozilla-org");
    const scanResult = scanWithRequests(requests);

    assert.equal(scanResult.scan.algorithmVersion, 6);
    assert.equal(scanResult.scan.grade, "B");
    assert.equal(scanResult.scan.score, 75);
    assert.equal(scanResult.scan.testsFailed, 2);
    assert.equal(scanResult.scan.testsPassed, 10);
    assert.equal(scanResult.scan.testsQuantity, 12);
    assert.equal(scanResult.scan.statusCode, 200);
    assert.equal(
      scanResult.scan.responseHeaders["content-type"],
      "text/html; charset=utf-8"
    );
  });

  describe("status code gating", () => {
    // Allowed: 2xx and 4xx except the non-representative ones.
    for (const status of [200, 204, 400, 401, 403, 405, 451]) {
      it(`scans on HTTP ${status}`, function () {
        const result = analyzeScan(requestsWithStatus(status));
        assert.equal(result.scan.statusCode, status);
      });
    }

    // Aborted: 1xx, all 3xx (unresolved redirects), non-representative 4xx
    // (404/408/410/429) and 5xx.
    for (const status of [199, 301, 302, 308, 404, 408, 410, 429, 500, 503]) {
      it(`aborts on HTTP ${status} with the status code attached`, function () {
        try {
          analyzeScan(requestsWithStatus(status));
          throw new Error("analyzeScan should have thrown");
        } catch (error) {
          assert.instanceOf(error, ScanAbortedError);
          const err = /** @type {ScanAbortedError} */ (error);
          assert.equal(
            err.scanAbortReason,
            ScanAbortReason.UNEXPECTED_STATUS_CODE
          );
          assert.equal(err.siteStatusCode, status);
          assert.match(error.message, new RegExp(`${status}`));
        }
      });
    }

    for (const wwwAuth of [
      'Basic realm="restricted"',
      'Digest realm="x"',
      'Negotiate, NTLM, Basic realm="x"',
    ]) {
      it(`does not scan a Basic/Digest 401 (${wwwAuth})`, function () {
        try {
          analyzeScan(requestsWithAuth(401, wwwAuth));
          throw new Error("analyzeScan should have thrown");
        } catch (error) {
          assert.instanceOf(error, ScanAbortedError);
          assert.equal(
            /** @type {ScanAbortedError} */ (error).scanAbortReason,
            ScanAbortReason.HTTP_AUTH
          );
        }
      });
    }

    it("still scans an app-level 401 (Bearer / no Basic challenge)", function () {
      const result = analyzeScan(requestsWithAuth(401, 'Bearer realm="api"'));
      assert.equal(result.scan.statusCode, 401);
    });

    it("still scans a 401 with no WWW-Authenticate header", function () {
      const result = analyzeScan(requestsWithStatus(401));
      assert.equal(result.scan.statusCode, 401);
    });

    it("does not scan an empty response with no security headers (Content-Length: 0)", function () {
      const req = requestsWithStatus(200);
      req.responses.auto?.headers.set("content-length", "0");
      try {
        analyzeScan(req);
        throw new Error("analyzeScan should have thrown");
      } catch (error) {
        assert.instanceOf(error, ScanAbortedError);
        assert.equal(
          /** @type {ScanAbortedError} */ (error).scanAbortReason,
          ScanAbortReason.EMPTY_RESPONSE
        );
      }
    });

    it("still scans an empty body that carries a security header", function () {
      const req = requestsWithStatus(200);
      req.responses.auto?.headers.set("content-length", "0");
      req.responses.auto?.headers.set(
        "strict-transport-security",
        "max-age=63072000"
      );
      assert.equal(analyzeScan(req).scan.statusCode, 200);
    });

    it("still scans when Content-Length is absent or non-zero", function () {
      assert.equal(analyzeScan(requestsWithStatus(200)).scan.statusCode, 200);
      const req = requestsWithStatus(200);
      req.responses.auto?.headers.set("content-length", "1024");
      assert.equal(analyzeScan(req).scan.statusCode, 200);
    });

    it("aborts as site-down when there is no response", function () {
      const req = emptyRequests();
      req.responses.auto = null;
      try {
        analyzeScan(req);
        throw new Error("analyzeScan should have thrown");
      } catch (error) {
        assert.instanceOf(error, ScanAbortedError);
        const err = /** @type {ScanAbortedError} */ (error);
        assert.equal(err.scanAbortReason, ScanAbortReason.SITE_DOWN);
        assert.equal(err.siteStatusCode, null);
      }
    });
  });
});
