import { describe, it } from "node:test";
import { assert } from "chai";
import {
  scan,
  analyzeScan,
  ScanAbortedError,
  ScanAbortReason,
} from "../src/scanner/index.js";
import { Site } from "../src/site.js";
import {
  emptyRequests,
  fixtureRequests,
  scanWithRequests,
} from "./helpers.js";

/** @typedef {import("../src/scanner/index.js").ScanResult} ScanResult */

describe("Scanner", () => {
  it("returns an error on an unknown host", async function () {
    const domain =
      Array(223)
        .fill(0)
        .map(() => String.fromCharCode(Math.random() * 26 + 97))
        .join("") + ".net";
    const site = Site.fromSiteString(domain);
    try {
      await scan(site);
      throw new Error("scan should throw");
    } catch (e) {
      if (e instanceof Error) {
        assert.match(e.message, /^The site seems to be down\./);
      } else {
        throw new Error("Unexpected error type");
      }
    }
  });

  it("returns expected results on observatory.mozilla.org", function () {
    const requests = fixtureRequests("observatory-mozilla-org");
    const scanResult = scanWithRequests(requests);

    assert.equal(scanResult.scan.algorithmVersion, 5);
    assert.equal(scanResult.scan.grade, "A+");
    assert.equal(scanResult.scan.score, 110);
    assert.equal(scanResult.scan.testsFailed, 0);
    assert.equal(scanResult.scan.testsPassed, 10);
    assert.equal(scanResult.scan.testsQuantity, 10);
    assert.equal(scanResult.scan.statusCode, 200);
    assert.equal(scanResult.scan.responseHeaders["content-type"], "text/html");
  });

  it("returns expected results on mozilla.org", function () {
    const requests = fixtureRequests("mozilla-org");
    const scanResult = scanWithRequests(requests);

    assert.equal(scanResult.scan.algorithmVersion, 5);
    assert.equal(scanResult.scan.grade, "B");
    assert.equal(scanResult.scan.score, 75);
    assert.equal(scanResult.scan.testsFailed, 2);
    assert.equal(scanResult.scan.testsPassed, 8);
    assert.equal(scanResult.scan.testsQuantity, 10);
    assert.equal(scanResult.scan.statusCode, 200);
    assert.equal(
      scanResult.scan.responseHeaders["content-type"],
      "text/html; charset=utf-8"
    );
  });

  describe("status code gating", () => {
    /** @param {number} status */
    const requestsWithStatus = (status) => {
      const req = emptyRequests();
      if (req.responses.auto) {
        req.responses.auto.status = status;
      }
      return req;
    };

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
        } catch (e) {
          assert.instanceOf(e, ScanAbortedError);
          const err = /** @type {ScanAbortedError} */ (e);
          assert.equal(err.scanAbortReason, ScanAbortReason.UNEXPECTED_STATUS_CODE);
          assert.equal(err.siteStatusCode, status);
          assert.match(e.message, new RegExp(`${status}`));
        }
      });
    }

    /** @param {number} status @param {string} wwwAuth */
    const requestsWithAuth = (status, wwwAuth) => {
      const req = requestsWithStatus(status);
      req.responses.auto?.headers.set("www-authenticate", wwwAuth);
      return req;
    };

    for (const wwwAuth of ['Basic realm="restricted"', "Digest realm=\"x\"", "Negotiate, NTLM, Basic realm=\"x\""]) {
      it(`does not scan a Basic/Digest 401 (${wwwAuth})`, function () {
        try {
          analyzeScan(requestsWithAuth(401, wwwAuth));
          throw new Error("analyzeScan should have thrown");
        } catch (e) {
          assert.instanceOf(e, ScanAbortedError);
          assert.equal(
            /** @type {ScanAbortedError} */ (e).scanAbortReason,
            ScanAbortReason.HTTP_AUTH
          );
        }
      });
    }

    it("still scans an app-level 401 (Bearer / no Basic challenge)", function () {
      const result = analyzeScan(requestsWithAuth(401, "Bearer realm=\"api\""));
      assert.equal(result.scan.statusCode, 401);
    });

    it("still scans a 401 with no WWW-Authenticate header", function () {
      const result = analyzeScan(requestsWithStatus(401));
      assert.equal(result.scan.statusCode, 401);
    });

    it("does not scan an empty response (Content-Length: 0)", function () {
      const req = requestsWithStatus(200);
      req.responses.auto?.headers.set("content-length", "0");
      try {
        analyzeScan(req);
        throw new Error("analyzeScan should have thrown");
      } catch (e) {
        assert.instanceOf(e, ScanAbortedError);
        assert.equal(
          /** @type {ScanAbortedError} */ (e).scanAbortReason,
          ScanAbortReason.EMPTY_RESPONSE
        );
      }
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
      } catch (e) {
        assert.instanceOf(e, ScanAbortedError);
        const err = /** @type {ScanAbortedError} */ (e);
        assert.equal(err.scanAbortReason, ScanAbortReason.SITE_DOWN);
        assert.equal(err.siteStatusCode, null);
      }
    });
  });
});
