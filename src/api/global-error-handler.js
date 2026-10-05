import { AppError } from "./errors.js";
import { STATUS_CODES } from "./utils.js";

/**
 * Global error handler
 * @param {import("fastify").FastifyError} error
 * @param {import("fastify").FastifyRequest} _request
 * @param {import("fastify").FastifyReply} reply
 * @returns {Promise<import("fastify").FastifyReply>}
 */
export default async function globalErrorHandler(error, _request, reply) {
  if (error instanceof AppError) {
    const body = { error: error.name, message: error.message };
    // Fork extension: a scan aborted by our scan gating also says why, so
    // clients can explain a missing grade without the batch endpoint.
    const { scanAbortReason, siteStatusCode } = /** @type {any} */ (error);
    if (scanAbortReason) {
      Object.assign(body, {
        not_scanned_reason: scanAbortReason,
        status_code: siteStatusCode ?? null,
      });
    }
    return reply.status(error.statusCode).send(body);
  }
  return reply
    .status(error.statusCode ?? STATUS_CODES.internalServerError)
    .send({
      error: "error-unknown",
      message: error.message,
    });
}
