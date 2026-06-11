import dns from "node:dns";

/**
 * Deep health check that verifies both the PostgreSQL connection pool
 * and external DNS resolution are functional.
 *
 * GET /api/v2/health
 *   200 → { status: "ok",       db: true,  dns: true  }
 *   503 → { status: "degraded", db: bool,  dns: bool, error: "..." }
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {Promise<void>}
 */
export default async function (fastify) {
  const pool = fastify.pg.pool;

  fastify.get("/health", async (_request, reply) => {
    /** @type {{ status: string, db: boolean, dns: boolean, error?: string }} */
    const result = { status: "ok", db: false, dns: false };
    const errors = [];

    // 1. Database pool check — SELECT 1
    try {
      await pool.query("SELECT 1");
      result.db = true;
    } catch (err) {
      errors.push(`db: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. DNS resolution check — resolve a well-known external hostname
    try {
      await new Promise((resolve, reject) => {
        dns.lookup("mozilla.org", (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
      result.dns = true;
    } catch (err) {
      errors.push(`dns: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (errors.length > 0) {
      result.status = "degraded";
      result.error = errors.join("; ");
      return reply.status(503).send(result);
    }

    return reply.status(200).send(result);
  });
}
