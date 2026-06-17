# Welcome to Mozilla's HTTP Observatory

[HTTP Observatory](https://developer.mozilla.org/en-US/observatory/) is a service that checks web sites for security-relevant headers. It is hosted by [MDN Web Docs](https://github.com/mdn).

## Getting Started

If you just want to scan a host, please head over to <https://developer.mozilla.org/en-US/observatory/>. If you want to
run the code locally or on your premises, continue reading.

### Running a simple scan from the command line

Using npx to install the package, simply run

```sh
npx @mdn/mdn-http-observatory mdn.dev
```

Subpaths like `example.com/path` and port numbers like `example.com:8080/path` are suported.

If you want to install the package first, use npm to install it globally

```sh
npm install --global @mdn/mdn-http-observatory
```

After that, the `mdn-http-observatory-scan` command should be available in your shell. To scan a host, run

```sh
mdn-http-observatory-scan mdn.dev
```

You can pass custom request headers as JSON using the `--headers` option:

```sh
mdn-http-observatory-scan --headers '{"X-Custom": "value"}' mdn.dev
```

**Warning:** Headers will also be sent on unencrypted HTTP requests, even if the host enforces HTTPS. Do not pass sensitive data.

Both methods return a JSON response of the following form:

```json
{
  "scan": {
    "algorithmVersion": 4,
    "grade": "A+",
    "error": null,
    "score": 105,
    "statusCode": 200,
    "testsFailed": 0,
    "testsPassed": 10,
    "testsQuantity": 10,
    "responseHeaders": {
      ...
    }
  },
  "tests": {
    "cross-origin-resource-sharing": {
      "expectation": "cross-origin-resource-sharing-not-implemented",
      "pass": true,
      "result": "cross-origin-resource-sharing-not-implemented",
      "scoreModifier": 0,
      "data": null
    },
    ...
  }
}
```

### Running a local API server

This needs a [postgres](https://www.postgresql.org/) database for the API to use as a persistence layer. All scans and results initiated via the API are stored in the database.

#### Configuration

Default configuration is read from a default `config/config.json` file. See [this file](src/config.js) for a list of possible configuration options.

Create a configuration file by copying the [`config/config-example.json`](conf/config-example.json) to `config/config.json`.
Put in your database credentials into `config/config.json`:

```json
{
  "database": {
    "database": "observatory",
    "user": "postgres"
  }
}
```

To initialize the database with the proper tables, use this command to migrate. This is a one-time action, but future code changes
might need further database changes, so run this migration every time the code is updated from the repository.

```sh
npm run migrate
```

Finally, start the server by running

```sh
npm start
```

The server is listening on your local interface on port `8080`. You can check the root path by opening <http://localhost:8080/> in your browser or `curl` the URL. The server should respond with `Welcome to the MDN Observatory!`.

## Scan eligibility (which responses are graded)

Before any test runs, the scanner decides whether the host's response is worth
grading. The grade reflects the **final** response after redirects are followed
(HTTPS chain preferred), so the status code below is that terminal status.

> **Note:** This is stricter and broader than upstream MDN HTTP Observatory,
> which grades only `2xx`, `3xx`, `401` and `403`. This deployment grades most
> `4xx` responses (security headers are emitted on them too) but drops `3xx`,
> the non-representative `4xx` codes, and content-less responses.

### By status code

| Status                                  | Graded? | Why                                                                                   |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `1xx`                                   | ❌      | Informational / non-final                                                             |
| `2xx`                                   | ✅      | Normal success                                                                        |
| `3xx`                                   | ❌      | Redirects are already followed (≤10 hops); a surviving `3xx` is an unresolved redirect carrying only a `Location` header |
| `400`, `402`, `405`, `406`, `451`, …    | ✅      | Most `4xx` — security headers are analyzable on error pages too                       |
| `401`                                   | ⚠️      | Graded **unless** it is a Basic/Digest auth challenge (see gates)                     |
| `403`                                   | ✅      | WAF / forbidden — usually still carries representative headers                        |
| `404`, `408`, `410`, `429`              | ❌      | Non-representative: content absent (404/410), request timeout (408), rate-limited (429) |
| `5xx`                                   | ❌      | Server erroring; headers likely come from an error handler                            |

**In short:** graded set = `2xx` + `4xx` except `{404, 408, 410, 429}`, then
subject to the content gates below.

### Gates (evaluated in order)

A response that fails any gate is not graded. The reason is machine-readable and
surfaced in the scan output (see below).

1. **Reachability** (`site-down`) — no HTTP or HTTPS response at all (DNS
   failure, connection refused, TLS failure, timeout).
2. **Status code** (`unexpected-status-code`) — status not in the graded set
   above (`1xx`, `3xx`, `404/408/410/429`, `5xx`).
3. **HTTP authentication** (`http-auth`) — a `401` whose `WWW-Authenticate`
   advertises **Basic** or **Digest** (matched even in mixed challenges such as
   `Negotiate, NTLM, Basic …`). These are browser-native challenges with an empty
   body. App-level `401`s (e.g. `Bearer`/token APIs, or gated SPAs that still
   render a page) are kept.
4. **Empty body** (`empty-response`) — `Content-Length: 0` **and** the response
   carries none of the graded security headers (HSTS, CSP, X-Frame-Options,
   X-Content-Type-Options, Referrer-Policy, Cross-Origin-\*, Permissions-Policy).
   An empty response that still sets a security header is graded; a missing
   `Content-Length` (e.g. chunked responses) is left scannable.

### Not-graded output

When a host is not graded, the scan reports the reason instead of a grade. The
CLI and the batch full-details API include `status_code` (the observed HTTP
status, `null` when unreachable) and `not_scanned_reason` (one of the codes
above):

```json
{
  "error": "Site responded with an unresolved redirect (HTTP status code 302).",
  "status_code": 302,
  "not_scanned_reason": "unexpected-status-code"
}
```

## Docker and Hardened Deployment

For containerized development and deployment, see `DOCKER.md`.

That document covers:

- the base Compose setup
- the hardened overlay in `docker-compose.hardened.yml`
- parallel validation on alternate ports before cutover
- promotion and rollback commands for the main deployment
- CI image scanning and supply-chain metadata changes

The primary health/version endpoint for Docker deployments is `GET /api/v2/version`.

## JSON API

**Note:** We provide these endpoints on our public deployment of HTTP Observatory at <https://observatory-api.mdn.mozilla.net/>

### POST `/api/v2/scan`

For integration in CI pipelines or similar applications, a JSON API endpoint is provided. The request rate is limited to one scan per host per `api.cooldown` (default: One minute) seconds. If exceeded, a cached result will be returned.

#### Query parameters

- `host` hostname (required)

#### Examples

- `POST /api/v2/scan?host=mdn.dev`
- `POST /api/v2/scan?host=google.com`

#### Result

On success, a JSON object is returned, structured like this example response:

```json
{
  "id": 77666718,
  "details_url": "https://developer.mozilla.org/en-US/observatory/analyze?host=mdn.dev",
  "algorithm_version": 4,
  "scanned_at": "2024-08-12T08:20:18.926Z",
  "error": null,
  "grade": "A+",
  "score": 105,
  "status_code": 200,
  "tests_failed": 0,
  "tests_passed": 10,
  "tests_quantity": 10
}
```

**Note:** For a full set of details about the host, use the provided link in the `details_url` field.

If an error occurred, an object like this is returned:

```json
{
  "error": "invalid-hostname-lookup",
  "message": "some.invalid.hostname.dev cannot be resolved"
}
```

## Migrating from the public V1 API to the V2 API

### Sunset of the V1 API

The previous iteration of the Observatory JSON API has been deprecated and shut down on October 31, 2024.

### Migrating your application

If you previously used the Observatory API with some automation or a CI context, the switch from the old `/api/v1/analyze` endpoint to the new `/api/v2/scan` endpoint should be painless:

- Replace all API calls to `POST https://http-observatory.security.mozilla.org/api/v1/analyze?host=<HOST TO SCAN>` with `POST https://observatory-api.mdn.mozilla.net/api/v2/scan?host=<HOST TO SCAN>`
- Be aware that the complete list of headers has been removed from the response.
- The POST parameters `rescan` and `hidden` in the POST body have been removed.
- Remove all other requests from your application, if any. If you need any additional information about your scan, open the URL from the `detail_url` field of the response in your browser.
- Note that scans are still limited to one every minute per host, otherwise a cached response is returned.

## Contributing

Our project welcomes contributions from any member of our community.
To get started contributing, please see our [Contributor Guide](CONTRIBUTING.md).

By participating in and contributing to our projects and discussions, you acknowledge that you have read and agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Communications

If you have any questions, please reach out to us on [Mozilla Developer Network](https://developer.mozilla.org).

## License

This project is licensed under the [Mozilla Public License 2.0](LICENSE).
