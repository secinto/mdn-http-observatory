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

## JSON API

**Note:** We provide these endpoints on our public deployment of HTTP Observatory at <https://observatory-api.mdn.mozilla.net/>

### Configuration

The `HTTPOBS_BASE_URL` environment variable can be used to customize the `details_url` field in API responses. If not set, it defaults to the MDN Observatory URL.

Example: `HTTPOBS_BASE_URL=https://your-domain.com`

---

### POST `/api/v2/scan`

Returns a summary of the scan results for a given host. Ideal for CI/CD pipelines and quick security checks.

**Rate Limiting:** One scan per host per `api.cooldown` (default: 60 seconds). Cached results are returned if rate limit is exceeded.

- `host` hostname (required)

#### Examples

- `POST /api/v2/scan?host=mdn.dev`
- `POST /api/v2/scan?host=google.com`

#### Response

On success, returns a JSON object with scan summary:

```json
{
  "id": 77666718,
  "details_url": "https://developer.mozilla.org/en-US/observatory/analyze?host=mdn.dev",
  "algorithm_version": 5,
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

On error:

```json
{
  "error": "invalid-hostname-lookup",
  "message": "some.invalid.hostname.dev cannot be resolved"
}
```

---

### POST `/api/v2/scanFullDetails`

Returns the same summary data as `/api/v2/scan` plus complete details of all security tests performed. Use this when you need full test results in a single API call.

**Rate Limiting:** Same as `/api/v2/scan` - one scan per host per `api.cooldown` seconds.

#### Query Parameters

* `host` - hostname (required)

#### Examples

```bash
curl -X POST "http://localhost:8080/api/v2/scanFullDetails?host=mdn.dev"
curl -X POST "http://localhost:8080/api/v2/scanFullDetails?host=example.com"
```

#### Response

Returns scan summary plus `fullDetails` object containing complete scan and test information:

```json
{
  "id": 77666718,
  "details_url": "https://your-domain.com/analyze?host=mdn.dev",
  "algorithm_version": 5,
  "scanned_at": "2024-08-12T08:20:18.926Z",
  "error": null,
  "grade": "A+",
  "score": 105,
  "status_code": 200,
  "tests_failed": 0,
  "tests_passed": 10,
  "tests_quantity": 10,
  "fullDetails": {
    "scan": {
      "algorithmVersion": 5,
      "grade": "A+",
      "error": null,
      "score": 105,
      "statusCode": 200,
      "testsFailed": 0,
      "testsPassed": 10,
      "testsQuantity": 10,
      "responseHeaders": {
        "content-type": "text/html; charset=utf-8",
        "strict-transport-security": "max-age=63072000",
        ...
      }
    },
    "tests": {
      "content-security-policy": {
        "expectation": "csp-implemented-with-no-unsafe",
        "pass": true,
        "result": "csp-implemented-with-no-unsafe",
        "scoreModifier": 0,
        "data": {...},
        "http": true,
        "meta": false,
        "policy": {...}
      },
      "cookies": {
        "expectation": "cookies-secure-with-httponly-sessions",
        "pass": true,
        "result": "cookies-secure-with-httponly-sessions",
        "scoreModifier": 5,
        "data": {...}
      },
      ...
    }
  }
}
```

---

### GET/POST `/api/v2/analyze`

Returns comprehensive analysis including scan results, all test details, and historical scan data for the host. This endpoint provides the most complete dataset.

**Rate Limiting:** 
- GET requests: Returns cached results up to `api.cacheTimeForGet` seconds old (default: 24 hours)
- POST requests: Same as `/api/v2/scan` - one scan per `api.cooldown` seconds

#### Query Parameters

* `host` - hostname (required)

#### Examples

```bash
# GET - returns recent cached results if available
curl "http://localhost:8080/api/v2/analyze?host=mdn.dev"

# POST - forces a new scan (subject to rate limiting)
curl -X POST "http://localhost:8080/api/v2/analyze?host=mdn.dev"
```

#### Response

Returns a comprehensive object with scan results, tests, and history:

```json
{
  "scan": {
    "id": 77666718,
    "algorithm_version": 5,
    "scanned_at": "2024-08-12T08:20:18.926Z",
    "error": null,
    "grade": "A+",
    "score": 105,
    "status_code": 200,
    "tests_failed": 0,
    "tests_passed": 10,
    "tests_quantity": 10,
    "site_id": 12345
  },
  "tests": {
    "content-security-policy": {
      "expectation": "csp-implemented-with-no-unsafe",
      "pass": true,
      "result": "csp-implemented-with-no-unsafe",
      "scoreModifier": 0,
      ...
    },
    ...
  },
  "history": [
    {
      "id": 77666718,
      "scanned_at": "2024-08-12T08:20:18.926Z",
      "grade": "A+",
      "score": 105
    },
    {
      "id": 77555432,
      "scanned_at": "2024-08-10T14:15:22.123Z",
      "grade": "A",
      "score": 100
    },
    ...
  ]
}
```

---

### Comparison of Endpoints

| Endpoint | Use Case | Includes History | Includes Full Test Details | Response Time |
|----------|----------|------------------|---------------------------|---------------|
| `/api/v2/scan` | Quick checks, CI/CD | ❌ | ❌ | Fastest |
| `/api/v2/scanFullDetails` | Detailed analysis, single call | ❌ | ✅ | Medium |
| `/api/v2/analyze` | Complete analysis with history | ✅ | ✅ | Slower (includes DB queries) |


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

