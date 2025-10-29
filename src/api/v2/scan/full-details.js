import { CONFIG } from "../../../config.js";
import { selectScanLatestScanByHost as selectScanLatestScanBySite } from "../../../database/repository.js";
import { scan } from "../../../scanner/index.js";
import { Site } from "../../../site.js";
import { checkSitename, executeScan } from "../utils.js";

/**
 * @typedef {import("pg").Pool} Pool
 */

// Schema for scanFullDetails endpoint - extends scan response with fullDetails
const scanFullDetailsSchema = {
  querystring: {
    type: "object",
    properties: {
      host: {
        type: "string",
      },
    },
    required: ["host"],
  },
  response: {
    200: {
      type: "object",
      properties: {
        id: { type: "number" },
        details_url: { type: "string" },
        algorithm_version: { type: "number" },
        scanned_at: { type: "string" },
        error: { type: ["string", "null"] },
        grade: { type: ["string", "null"] },
        score: { type: ["number", "null"] },
        status_code: { type: ["number", "null"] },
        tests_failed: { type: "number" },
        tests_passed: { type: "number" },
        tests_quantity: { type: "number" },
        fullDetails: {
          type: "object",
          properties: {
            scan: { type: "object", additionalProperties: true },
            tests: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
};

/**
 * Register the API - default export
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {Promise<void>}
 */
export default async function (fastify) {
  const pool = fastify.pg.pool;
  fastify.post(
    "/scanFullDetails",
    { schema: scanFullDetailsSchema },
    async (request, _reply) => {
      const query = /** @type {import("../../v2/schemas.js").ScanQuery} */ (
        request.query
      );

      const hostname = query.host.trim().toLowerCase();
      let site = Site.fromSiteString(hostname);
      site = await checkSitename(site);
      return await scanOrReturnRecentWithFullDetails(
        pool,
        site,
        CONFIG.api.cooldown
      );
    }
  );
}

/**
 *
 * @param {Pool} pool
 * @param {Site} site
 * @param {number} age
 * @returns {Promise<any>}
 */
async function scanOrReturnRecentWithFullDetails(pool, site, age) {
  let scanRow = await selectScanLatestScanBySite(pool, site.asSiteKey(), age);

  if (!scanRow) {
    // Do a fresh scan - this will save to DB and return scanRow
    scanRow = await executeScan(pool, site);
  }

  // Always run a fresh scan to get the full test details
  // (the DB only stores summary data, not full test results)
  const fullScanResult = await scan(site);

  // Build details URL using configurable base URL
  let detailsUrl;
  if (CONFIG.api.baseUrl) {
    detailsUrl = `${CONFIG.api.baseUrl}/analyze?host=${encodeURIComponent(site.asSiteKey())}`;
  } else {
    detailsUrl = `https://developer.mozilla.org/en-US/observatory/analyze?host=${encodeURIComponent(site.asSiteKey())}`;
  }

  // Remove scoreDescription from tests as done in scan.js
  const tests = Object.fromEntries(
    Object.entries(fullScanResult.tests).map(([key, test]) => {
      const { scoreDescription, ...rest } = test;
      return [key, rest];
    })
  );

  // Build the response object explicitly
  const response = {
    id: scanRow.id,
    details_url: detailsUrl,
    algorithm_version: scanRow.algorithm_version,
    scanned_at: scanRow.start_time,
    error: scanRow.error,
    grade: scanRow.grade,
    score: scanRow.score,
    status_code: scanRow.status_code,
    tests_failed: scanRow.tests_failed,
    tests_passed: scanRow.tests_passed,
    tests_quantity: scanRow.tests_quantity,
    fullDetails: {
      scan: fullScanResult.scan,
      tests: tests,
    },
  };

  return response;
}
