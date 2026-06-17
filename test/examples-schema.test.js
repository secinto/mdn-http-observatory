import { describe, it } from "node:test";
import { assert } from "chai";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

import { SCHEMAS } from "../src/api/v2/schemas.js";

// The files in scripts/examples are saved by scripts/concurrent-scan.sh, which
// calls the scanFullDetails endpoint and writes either:
//   - the successful response (the per-host full-details object), or
//   - its own error record: { error, message, http_code?, host, timestamp }.
// The batch endpoint returns the SAME per-host object keyed by host, so its
// response schema is the canonical description of the success shape.
const mapSchema = SCHEMAS.scanBatchFullDetails.response[200];
const itemSchema = mapSchema.additionalProperties;

const EXAMPLES_DIR = path.join("scripts", "examples");

/** @returns {string[]} paths to every example JSON file */
function exampleFiles() {
  return fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(EXAMPLES_DIR, f));
}

/**
 * A successful scan response carries the nested fullDetails object.
 * @param {any} example
 * @returns {boolean}
 */
function isSuccessResponse(example) {
  return (
    example != null && typeof example === "object" && "fullDetails" in example
  );
}

describe("scripts/examples scan output files", () => {
  // strict: false mirrors Fastify's lenient response-schema handling.
  // Ajv ships as CommonJS; cast the default import to construct it under
  // checkJs without an interop type error (runtime works as-is).
  const ajv = new /** @type {any} */ (Ajv)({
    allErrors: true,
    strict: false,
  });
  const validateItem = ajv.compile(itemSchema);
  const validateMap = ajv.compile(mapSchema);

  const files = exampleFiles();

  it("finds the example files", () => {
    assert.isAtLeast(files.length, 3, "expected at least three example files");
  });

  for (const file of files) {
    describe(path.basename(file), () => {
      /** @type {any} */
      let example;

      it("loads as valid JSON", () => {
        example = JSON.parse(fs.readFileSync(file, "utf8")); // throws -> fails
        assert.isObject(example);
      });

      it("matches a known shape (success response or error record)", () => {
        if (isSuccessResponse(example)) {
          // Success: validate against the per-host full-details schema, both
          // standalone and wrapped as a host-keyed batch response map.
          assert.isTrue(
            validateItem(example),
            `item schema errors: ${JSON.stringify(validateItem.errors)}`
          );
          const host = path.basename(file).split("_")[0] ?? "host";
          assert.isTrue(
            validateMap({ [host]: example }),
            `map schema errors: ${JSON.stringify(validateMap.errors)}`
          );
        } else {
          // Error record written by concurrent-scan.sh on a failed scan.
          assert.isString(example.error, "error record needs a string `error`");
          assert.isString(
            example.message,
            "error record needs a string `message`"
          );
        }
      });

      it("has well-formed connection_info when it is a success response", function () {
        if (!isSuccessResponse(example)) {
          return; // error records legitimately carry no connection_info
        }
        assert.property(example, "connection_info");
        const ci = example.connection_info;
        assert.isBoolean(ci.certificateVerified);
        assert.isBoolean(ci.legacyTlsRenegotiation);
        assert.isArray(ci.fallbacksApplied);
        assert.isTrue(
          ci.certificateError === null ||
            typeof ci.certificateError === "string"
        );
      });
    });
  }

  it("the schema rejects malformed data (validator has teeth)", () => {
    const success = files
      .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
      .find(isSuccessResponse);
    assert.isOk(success, "expected at least one success-response example");

    const badBoolean = structuredClone(success);
    badBoolean.connection_info.certificateVerified = "yes";
    assert.isFalse(
      validateItem(badBoolean),
      "expected non-boolean certificateVerified to be rejected"
    );

    const badScore = structuredClone(success);
    badScore.score = "high";
    assert.isFalse(
      validateItem(badScore),
      "expected non-number score to be rejected"
    );

    const badFallbacks = structuredClone(success);
    badFallbacks.connection_info.fallbacksApplied = "nope";
    assert.isFalse(
      validateItem(badFallbacks),
      "expected non-array fallbacksApplied to be rejected"
    );
  });
});
