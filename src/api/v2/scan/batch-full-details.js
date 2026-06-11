import { CONFIG } from "../../../config.js";
import { selectScanLatestScanByHost as selectScanLatestScanBySite } from "../../../database/repository.js";
import { scan } from "../../../scanner/index.js";
import { Site } from "../../../site.js";
import { checkSitename, executeScan } from "../utils.js";
import { SCHEMAS } from "../schemas.js";

/**
 * @typedef {import("pg").Pool} Pool
 */

// Configuration
const DEFAULT_CONCURRENCY = 5;

/**
 * Run async operations with concurrency limit
 * @param {string[]} items - Items to process
 * @param {(item: string) => Promise<any>} fn - Async function to run for each item
 * @param {number} limit - Maximum concurrent operations
 * @returns {Promise<Record<string, any>>} - Results keyed by item
 */
async function runWithConcurrency(items, fn, limit) {
  /** @type {Record<string, any>} */
  const results = {};
  /** @type {Set<Promise<void>>} */
  const executing = new Set();

  for (const item of items) {
    const promise = fn(item).then((result) => {
      results[item] = result;
      executing.delete(promise);
    });
    executing.add(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Scan a single URL and return result or error
 * @param {Pool} pool
 * @param {string} url
 * @returns {Promise<any>}
 */
async function scanSingleUrl(pool, url) {
  try {
    const hostname = url.trim().toLowerCase();
    let site = Site.fromSiteString(hostname);
    site = await checkSitename(site);

    return await scanWithFullDetails(pool, site, CONFIG.api.cooldown);
  } catch (err) {
    const error = /** @type {Error} */ (err);
    return {
      success: false,
      error: error.name || "error-unknown",
      errorType: error.constructor?.name || "Error",
      message: error.message || "Unknown error occurred",
    };
  }
}

/**
 * Perform scan and return full details
 * @param {Pool} pool
 * @param {Site} site
 * @param {number} age - Cache age in seconds
 * @returns {Promise<any>}
 */
async function scanWithFullDetails(pool, site, age) {
  let scanRow = await selectScanLatestScanBySite(pool, site.asSiteKey(), age);
  let fullScanResult;

  if (!scanRow) {
    const result = await executeScan(pool, site);
    scanRow = result.scanRow;
    fullScanResult = result.scanResult;
  } else {
    // Cached scan exists, but we need full details, so scan again
    fullScanResult = await scan(site);
  }

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

  return {
    success: true,
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
    connection_info: scanRow.connection_info || null,
    fullDetails: {
      scan: fullScanResult.scan,
      tests: tests,
    },
  };
}

/**
 * Register the batch scan API - default export
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {Promise<void>}
 */
export default async function (fastify) {
  const pool = fastify.pg.pool;

  fastify.post(
    "/scanBatchFullDetails",
    { schema: SCHEMAS.scanBatchFullDetails },
    async (request, _reply) => {
      const body = /** @type {{ urls: string[] }} */ (request.body);
      const urls = body.urls;

      // Deduplicate URLs while preserving case for response keys
      const seen = new Set();
      const uniqueUrls = urls.filter((url) => {
        const normalized = url.trim().toLowerCase();
        if (seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      });

      // Use normalized URLs as keys for consistent lookups
      const normalizedUrls = uniqueUrls.map((u) => u.trim().toLowerCase());

      const results = await runWithConcurrency(
        normalizedUrls,
        (url) => scanSingleUrl(pool, url),
        DEFAULT_CONCURRENCY
      );

      return results;
    }
  );
}
