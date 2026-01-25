#!/usr/bin/env bash
#
# concurrent-scan.sh - Concurrent URL scanner for MDN HTTP Observatory
#
# This script reads URLs from an input file and concurrently scans them
# using the HTTP Observatory API, storing results in an output directory.
#
# Usage:
#   ./concurrent-scan.sh -i <input_file> -o <output_dir> [-c <concurrency>] [-r <retries>]
#
# Environment Variables:
#   SCAN_API_URL  - API base URL (default: http://localhost:8080)
#
# Examples:
#   ./concurrent-scan.sh -i urls.txt -o ./results
#   ./concurrent-scan.sh -i urls.txt -o ./results -c 10
#   SCAN_API_URL=https://api.example.com ./concurrent-scan.sh -i urls.txt -o ./results
#

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

# API URL from environment variable or default
SCAN_API_URL="${SCAN_API_URL:-http://localhost:8080}"

# Default values
DEFAULT_CONCURRENCY=5
DEFAULT_RETRIES=3
DEFAULT_PORT=443
DEFAULT_TIMEOUT=120

# Colors for output (disabled if not a terminal)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

# =============================================================================
# Global Variables
# =============================================================================

INPUT_FILE=""
OUTPUT_DIR=""
CONCURRENCY="$DEFAULT_CONCURRENCY"
RETRIES="$DEFAULT_RETRIES"
TIMEOUT="$DEFAULT_TIMEOUT"
VERBOSE=false

# Counters (using temp files for parallel processing)
TEMP_DIR=""

# =============================================================================
# Functions
# =============================================================================

usage() {
    cat << EOF
Usage: $(basename "$0") -i <input_file> -o <output_dir> [options]

Concurrently scan URLs using the MDN HTTP Observatory API.

Required arguments:
  -i, --input <file>      Input file containing URLs (one per line)
  -o, --output <dir>      Output directory for scan results

Optional arguments:
  -c, --concurrency <n>   Number of parallel scans (default: $DEFAULT_CONCURRENCY)
  -r, --retries <n>       Number of retry attempts on failure (default: $DEFAULT_RETRIES)
  -t, --timeout <secs>    Request timeout in seconds (default: $DEFAULT_TIMEOUT)
  -v, --verbose           Enable verbose output
  -h, --help              Show this help message

Environment variables:
  SCAN_API_URL            API base URL (default: http://localhost:8080)

Input file format:
  The input file should contain one URL per line. Supported formats:
    - example.com              (scans https://example.com:443)
    - example.com:8443         (scans https://example.com:8443)
    - https://example.com      (scans https://example.com:443)
    - https://example.com:8443 (scans https://example.com:8443)
    - https://example.com/path (extracts host, scans https://example.com:443)

Output files:
  Results are saved as JSON files with naming format:
    {hostname}_{YYYYMMDD_HHMMSS}_{port}.json

Examples:
  # Basic usage
  $(basename "$0") -i urls.txt -o ./results

  # With custom concurrency
  $(basename "$0") -i urls.txt -o ./results -c 10

  # With custom API URL
  SCAN_API_URL=https://observatory.example.com $(basename "$0") -i urls.txt -o ./results

  # Verbose mode with more retries
  $(basename "$0") -i urls.txt -o ./results -v -r 5
EOF
}

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_verbose() {
    if [[ "$VERBOSE" == true ]]; then
        echo -e "${BLUE}[DEBUG]${NC} $*"
    fi
}

# Parse URL and extract hostname and port
# Input formats:
#   - example.com
#   - example.com:8443
#   - https://example.com
#   - https://example.com:8443
#   - https://example.com:8443/path
# Output: "hostname:port" (port defaults to 443)
parse_url() {
    local url="$1"
    local hostname=""
    local port="$DEFAULT_PORT"

    # Remove leading/trailing whitespace
    url="$(echo "$url" | xargs)"

    # Skip empty lines and comments
    if [[ -z "$url" || "$url" =~ ^[[:space:]]*# ]]; then
        echo ""
        return
    fi

    # Remove protocol prefix if present
    url="${url#http://}"
    url="${url#https://}"

    # Remove path if present (everything after first /)
    url="${url%%/*}"

    # Extract hostname and port
    if [[ "$url" =~ .*:.* ]]; then
        # Has port specified
        hostname="${url%:*}"
        port="${url##*:}"
        # Validate port is numeric
        if ! [[ "$port" =~ ^[0-9]+$ ]]; then
            log_warning "Invalid port in '$1', using default $DEFAULT_PORT"
            port="$DEFAULT_PORT"
        fi
    else
        hostname="$url"
    fi

    # Convert hostname to lowercase
    hostname="$(echo "$hostname" | tr '[:upper:]' '[:lower:]')"

    # Basic hostname validation
    if [[ -z "$hostname" || ! "$hostname" =~ \. ]]; then
        log_warning "Invalid hostname: '$1'"
        echo ""
        return
    fi

    echo "${hostname}:${port}"
}

# Perform a single scan with retries
# Arguments: hostname port
scan_url() {
    local hostname="$1"
    local port="$2"
    local host_param="${hostname}:${port}"
    local timestamp
    local output_file
    local response
    local http_code
    local attempt

    timestamp="$(date +%Y%m%d_%H%M%S)"
    output_file="${OUTPUT_DIR}/${hostname}_${timestamp}_${port}.json"

    log_verbose "Scanning ${host_param}..."

    for ((attempt=1; attempt<=RETRIES; attempt++)); do
        # Create temp file for response
        local temp_response
        temp_response="$(mktemp)"

        # Make API request
        http_code=$(curl -s -w "%{http_code}" \
            --max-time "$TIMEOUT" \
            -X POST \
            -o "$temp_response" \
            "${SCAN_API_URL}/api/v2/scanFullDetails?host=${host_param}" 2>/dev/null) || http_code="000"

        if [[ "$http_code" == "200" ]]; then
            # Success - save result
            mv "$temp_response" "$output_file"
            log_success "${hostname}:${port} -> $(basename "$output_file")"

            # Increment success counter
            echo "1" >> "${TEMP_DIR}/success.count"
            return 0
        elif [[ "$http_code" == "422" ]]; then
            # Client error (invalid hostname, etc.) - don't retry
            local error_msg
            error_msg=$(cat "$temp_response" 2>/dev/null | grep -o '"message":"[^"]*"' | cut -d'"' -f4 || echo "Validation error")
            rm -f "$temp_response"
            log_error "${hostname}:${port} - ${error_msg} (HTTP ${http_code})"

            # Save error response
            echo "{\"error\": \"validation_error\", \"message\": \"${error_msg}\", \"http_code\": ${http_code}, \"host\": \"${host_param}\", \"timestamp\": \"${timestamp}\"}" > "$output_file"

            # Increment failure counter
            echo "1" >> "${TEMP_DIR}/failed.count"
            return 1
        else
            # Server error or network issue - retry
            rm -f "$temp_response"
            if [[ $attempt -lt $RETRIES ]]; then
                log_verbose "Attempt $attempt failed for ${host_param} (HTTP ${http_code}), retrying..."
                sleep $((attempt * 2))  # Exponential backoff
            fi
        fi
    done

    # All retries exhausted
    log_error "${hostname}:${port} - Failed after ${RETRIES} attempts"

    # Save error info
    echo "{\"error\": \"scan_failed\", \"message\": \"Failed after ${RETRIES} attempts\", \"host\": \"${host_param}\", \"timestamp\": \"${timestamp}\"}" > "$output_file"

    # Increment failure counter
    echo "1" >> "${TEMP_DIR}/failed.count"
    return 1
}

# Process a single parsed URL (hostname:port format)
# This function is called by xargs and must be self-contained
process_parsed_url() {
    local parsed="$1"
    local hostname="${parsed%:*}"
    local port="${parsed##*:}"
    local host_param="${hostname}:${port}"
    local timestamp
    local output_file
    local http_code
    local attempt

    timestamp="$(date +%Y%m%d_%H%M%S)"
    output_file="${OUTPUT_DIR}/${hostname}_${timestamp}_${port}.json"

    # Logging functions
    log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
    log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
    log_verbose() { if [[ "$VERBOSE" == true ]]; then echo -e "${BLUE}[DEBUG]${NC} $*"; fi; }

    log_verbose "Scanning ${host_param}..."

    for ((attempt=1; attempt<=RETRIES; attempt++)); do
        local temp_response
        temp_response="$(mktemp)"

        http_code=$(curl -s -w "%{http_code}" \
            --max-time "$TIMEOUT" \
            -X POST \
            -o "$temp_response" \
            "${SCAN_API_URL}/api/v2/scanFullDetails?host=${host_param}" 2>/dev/null) || http_code="000"

        if [[ "$http_code" == "200" ]]; then
            mv "$temp_response" "$output_file"
            log_success "${hostname}:${port} -> $(basename "$output_file")"
            echo "1" >> "${TEMP_DIR}/success.count"
            return 0
        elif [[ "$http_code" == "422" ]]; then
            local error_msg
            error_msg=$(cat "$temp_response" 2>/dev/null | grep -o '"message":"[^"]*"' | cut -d'"' -f4 || echo "Validation error")
            rm -f "$temp_response"
            log_error "${hostname}:${port} - ${error_msg} (HTTP ${http_code})"
            echo "{\"error\": \"validation_error\", \"message\": \"${error_msg}\", \"http_code\": ${http_code}, \"host\": \"${host_param}\", \"timestamp\": \"${timestamp}\"}" > "$output_file"
            echo "1" >> "${TEMP_DIR}/failed.count"
            return 1
        else
            rm -f "$temp_response"
            if [[ $attempt -lt $RETRIES ]]; then
                log_verbose "Attempt $attempt failed for ${host_param} (HTTP ${http_code}), retrying..."
                sleep $((attempt * 2))
            fi
        fi
    done

    log_error "${hostname}:${port} - Failed after ${RETRIES} attempts"
    echo "{\"error\": \"scan_failed\", \"message\": \"Failed after ${RETRIES} attempts\", \"host\": \"${host_param}\", \"timestamp\": \"${timestamp}\"}" > "$output_file"
    echo "1" >> "${TEMP_DIR}/failed.count"
    return 1
}

# Export function and variables for use with xargs
export -f process_parsed_url
export SCAN_API_URL OUTPUT_DIR RETRIES TIMEOUT VERBOSE TEMP_DIR
export RED GREEN YELLOW BLUE NC

# Main scanning function
run_scans() {
    local total_urls
    local valid_urls=()
    local line
    local parsed

    # Read and validate URLs
    while IFS= read -r line || [[ -n "$line" ]]; do
        parsed="$(parse_url "$line")"
        if [[ -n "$parsed" ]]; then
            valid_urls+=("$parsed")
        fi
    done < "$INPUT_FILE"

    total_urls=${#valid_urls[@]}

    if [[ $total_urls -eq 0 ]]; then
        log_error "No valid URLs found in input file"
        exit 1
    fi

    log_info "Starting scan of ${total_urls} URLs with concurrency ${CONCURRENCY}"
    log_info "API URL: ${SCAN_API_URL}"
    log_info "Output directory: ${OUTPUT_DIR}"
    echo ""

    # Process URLs in parallel using xargs
    # Using exported function to avoid command line length issues
    printf '%s\n' "${valid_urls[@]}" | \
        xargs -P "$CONCURRENCY" -I {} bash -c 'process_parsed_url "$@"' _ {}

    echo ""
}

# Print summary
print_summary() {
    local success_count=0
    local failed_count=0
    local total_count

    if [[ -f "${TEMP_DIR}/success.count" ]]; then
        success_count=$(wc -l < "${TEMP_DIR}/success.count")
    fi

    if [[ -f "${TEMP_DIR}/failed.count" ]]; then
        failed_count=$(wc -l < "${TEMP_DIR}/failed.count")
    fi

    total_count=$((success_count + failed_count))

    echo "=============================================="
    echo "                 SCAN SUMMARY                 "
    echo "=============================================="
    echo -e "Total scanned:  ${total_count}"
    echo -e "Successful:     ${GREEN}${success_count}${NC}"
    echo -e "Failed:         ${RED}${failed_count}${NC}"
    echo "=============================================="
    echo "Results saved to: ${OUTPUT_DIR}"
}

# Cleanup function
cleanup() {
    if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
        rm -rf "$TEMP_DIR"
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -i|--input)
                INPUT_FILE="$2"
                shift 2
                ;;
            -o|--output)
                OUTPUT_DIR="$2"
                shift 2
                ;;
            -c|--concurrency)
                CONCURRENCY="$2"
                shift 2
                ;;
            -r|--retries)
                RETRIES="$2"
                shift 2
                ;;
            -t|--timeout)
                TIMEOUT="$2"
                shift 2
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done

    # Validate required arguments
    if [[ -z "$INPUT_FILE" ]]; then
        log_error "Input file is required (-i)"
        usage
        exit 1
    fi

    if [[ -z "$OUTPUT_DIR" ]]; then
        OUTPUT_DIR="results"
        log_info "No output directory specified. Using default: $OUTPUT_DIR"
    fi

    # Validate input file exists
    if [[ ! -f "$INPUT_FILE" ]]; then
        log_error "Input file not found: $INPUT_FILE"
        exit 1
    fi

    # Validate concurrency is a positive number
    if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$CONCURRENCY" -lt 1 ]]; then
        log_error "Concurrency must be a positive number"
        exit 1
    fi

    # Create output directory if it doesn't exist
    if [[ ! -d "$OUTPUT_DIR" ]]; then
        mkdir -p "$OUTPUT_DIR"
        log_info "Created output directory: $OUTPUT_DIR"
    fi

    # Create temp directory for counters
    TEMP_DIR="$(mktemp -d)"
    trap cleanup EXIT

    # Check for required commands
    if ! command -v curl &> /dev/null; then
        log_error "curl is required but not installed"
        exit 1
    fi

    # Run the scans
    run_scans

    # Print summary
    print_summary
}

# Run main function
main "$@"
