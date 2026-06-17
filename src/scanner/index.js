import { MINIMUM_SCORE_FOR_EXTRA_CREDIT } from "../grader/charts.js";
import {
  getGradeForScore,
  getScoreDescription,
  getScoreModifier,
} from "../grader/grader.js";
import { retrieve } from "../retriever/retriever.js";
import { ALGORITHM_VERSION } from "../constants.js";
import { NUM_TESTS } from "../constants.js";
import { ALL_TESTS } from "../constants.js";

/**
 * @typedef {import("../types.js").ScanResult} ScanResult
 * @typedef {import("../types.js").Output} Output
 * @typedef {import("../types.js").StringMap} StringMap
 * @typedef {import("../types.js").TestMap} TestMap
 * @typedef {import("../site.js").Site} Site
 */

/**
 * Machine-readable reasons a scan can be aborted before any test runs.
 * Surfaced to downstream consumers (report generator, dashboard) so a host
 * that could not be scanned is distinguishable from one that was never in scope.
 * @readonly
 */
export const ScanAbortReason = {
  SITE_DOWN: "site-down",
  UNEXPECTED_STATUS_CODE: "unexpected-status-code",
  HTTP_AUTH: "http-auth",
  EMPTY_RESPONSE: "empty-response",
};

/**
 * The 4xx codes we refuse to grade because the response is unlikely to
 * represent the site's real configuration: 404/410 (content absent),
 * 408 (request timeout) and 429 (rate limited). All other 4xx codes are
 * graded, since security headers are typically emitted on them too.
 * @type {ReadonlySet<number>}
 */
export const NON_REPRESENTATIVE_STATUSES = new Set([404, 408, 410, 429]);

/**
 * HTTP authentication schemes whose 401 challenge is browser-native and serves
 * no application content (an empty body behind a native login dialog). A site
 * gated only by these has nothing to grade. App-level 401s (e.g. Bearer/token
 * APIs, or SPAs that still render a full page) are intentionally NOT listed and
 * remain scannable.
 * @type {ReadonlySet<string>}
 */
const CONTENTLESS_AUTH_SCHEMES = new Set(["basic", "digest"]);

/**
 * True when a `WWW-Authenticate` header advertises a content-less HTTP auth
 * challenge (Basic/Digest). Matches the scheme token at the start of any
 * comma-separated challenge so it also catches mixed challenges
 * (e.g. `Negotiate, NTLM, Basic realm="..."`).
 * @param {unknown} headerValue
 * @returns {boolean}
 */
export function isContentlessAuthChallenge(headerValue) {
  if (!headerValue) {
    return false;
  }
  const value = Array.isArray(headerValue)
    ? headerValue.join(", ")
    : String(headerValue);
  return [...CONTENTLESS_AUTH_SCHEMES].some((scheme) =>
    new RegExp(`(?:^|,)\\s*${scheme}(?:\\s|$)`, "i").test(value)
  );
}

/**
 * Error thrown when a scan is aborted before any test runs. Carries the
 * machine-readable reason and, when known, the observed HTTP status code so
 * downstream consumers can explain *why* a host was not scanned.
 */
export class ScanAbortedError extends Error {
  /**
   * @param {string} message
   * @param {string} reason - one of {@link ScanAbortReason}
   * @param {number | null} [siteStatusCode] - HTTP status the site responded with, if any
   */
  constructor(message, reason, siteStatusCode = null) {
    super(message);
    this.name = "ScanAbortedError";
    this.scanAbortReason = reason;
    this.siteStatusCode = siteStatusCode;
  }
}

/**
 * Analyzes a Requests object and returns scan results
 * @param {import("../types.js").Requests} requests
 * @returns {ScanResult}
 */
export function analyzeScan(requests) {
  if (!requests.responses.auto) {
    // We cannot connect at all, abort the test.
    const errorDetail = requests.connectionError
      ? ` (${requests.connectionError})`
      : "";
    throw new ScanAbortedError(
      `The site seems to be down.${errorDetail}`,
      ScanAbortReason.SITE_DOWN,
      null
    );
  }

  // We grade 2xx and most 4xx responses (security headers are analyzable on any
  // 4xx response), but not 1xx, 3xx or 5xx, nor the 4xx codes least likely to
  // represent the site's real configuration (see NON_REPRESENTATIVE_STATUSES).
  // 3xx is excluded because the retriever already follows redirects, so a 3xx
  // surviving as the final status means the redirect could not be resolved
  // (loop, hop limit, or missing Location) — such a bare redirect carries only
  // a Location header and no meaningful security headers to grade. 404/410
  // (content absent), 408 (request timeout) and 429 (rate limited) are likewise
  // transient or non-representative and would grade an error page.
  const { status } = requests.responses.auto;
  const isScannable =
    (status >= 200 && status < 300) ||
    (status >= 400 && status < 500 && !NON_REPRESENTATIVE_STATUSES.has(status));
  if (!isScannable) {
    const isRedirect = status >= 300 && status < 400;
    const message = isRedirect
      ? `Site responded with an unresolved redirect (HTTP status code ${status}).`
      : `Site did respond with an unexpected HTTP status code ${status}.`;
    throw new ScanAbortedError(
      message,
      ScanAbortReason.UNEXPECTED_STATUS_CODE,
      status
    );
  }

  // A 401 challenging for HTTP Basic/Digest auth is a browser-native challenge
  // with no application content behind it, so there is nothing to grade. (Other
  // 401s — e.g. token/Bearer APIs or gated pages that still render — are kept.)
  if (
    status === 401 &&
    isContentlessAuthChallenge(
      requests.responses.auto.headers["www-authenticate"]
    )
  ) {
    throw new ScanAbortedError(
      `Site is protected by HTTP authentication and serves no content to grade.`,
      ScanAbortReason.HTTP_AUTH,
      status
    );
  }

  // A response with an explicitly empty body (Content-Length: 0) has no page
  // content to grade. Narrow on purpose: only an explicit "0" triggers this — a
  // missing Content-Length (e.g. chunked responses) is left scannable so we
  // don't drop pages whose length the server simply didn't advertise.
  const contentLength = requests.responses.auto.headers["content-length"];
  if (contentLength != null && String(contentLength).trim() === "0") {
    throw new ScanAbortedError(
      `Site responded with an empty body (Content-Length: 0) and has no content to grade.`,
      ScanAbortReason.EMPTY_RESPONSE,
      status
    );
  }

  // Run all the tests on the result
  /**  @type {Output[]} */
  const results = ALL_TESTS.map((test) => {
    return test(requests);
  });

  /** @type {StringMap} */
  const responseHeaders = Object.entries(
    requests.responses.auto.headers
  ).reduce((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, /** @type {StringMap} */ ({}));
  const statusCode = requests.responses.auto.status;

  let testsPassed = 0;
  let scoreWithExtraCredit = 100;
  let uncurvedScore = scoreWithExtraCredit;

  results.forEach((result) => {
    if (result.result) {
      result.scoreDescription = getScoreDescription(result.result);
      result.scoreModifier = getScoreModifier(result.result);
      testsPassed += result.pass ? 1 : 0;
      scoreWithExtraCredit += result.scoreModifier;
      if (result.scoreModifier < 0) {
        uncurvedScore += result.scoreModifier;
      }
    }
  });

  // Only record the full score if the uncurved score already receives an A
  const score =
    uncurvedScore >= MINIMUM_SCORE_FOR_EXTRA_CREDIT
      ? scoreWithExtraCredit
      : uncurvedScore;

  const final = getGradeForScore(score);

  const tests = results.reduce((obj, result) => {
    const name = result.constructor.name;
    obj[name] = result;
    return obj;
  }, /** @type {TestMap} */ ({}));

  const defaultConnectionInfo = {
    certificateVerified: true,
    certificateError: null,
    legacyTlsRenegotiation: false,
    fallbacksApplied: [],
  };
  const connectionInfo =
    requests.session?.connectionInfo ?? defaultConnectionInfo;

  return {
    scan: {
      algorithmVersion: ALGORITHM_VERSION,
      grade: final.grade,
      error: null,
      score: final.score,
      statusCode: statusCode,
      testsFailed: NUM_TESTS - testsPassed,
      testsPassed: testsPassed,
      testsQuantity: NUM_TESTS,
      responseHeaders: responseHeaders,
      connectionInfo: connectionInfo,
    },
    tests,
  };
}

/**
 * @param {Site} site
 * @param {import("../types.js").ScanOptions} [options]
 * @returns {Promise<ScanResult>}
 */
export async function scan(site, options) {
  const r = await retrieve(site, options);
  return analyzeScan(r);
}
