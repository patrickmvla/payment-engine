#!/usr/bin/env bash
# Record an asciinema cast of the live engine handling a full payment flow.
# Used as the landing-page hero asset per
# [[2026-04-26-readme-cli-and-landing-asset]].
#
# Run after the live engine is deployed to Railway (or any reachable URL).
# Outputs payment-engine-demo.cast which can be uploaded to asciinema.org
# or self-hosted.
#
# Usage:
#   API_URL=https://payment-engine.up.railway.app ./scripts/record-demo.sh
#
# Prerequisites:
#   - asciinema (https://asciinema.org/docs/installation)
#   - jq (apt install jq / brew install jq)
#   - curl

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
OUT="${OUT:-payment-engine-demo.cast}"

# A unique amount per recording so cast doesn't dedupe under idempotency
# accidentally between runs.
AMOUNT="${AMOUNT:-15000}"
KEY_PREFIX="demo_$(date +%s)"

echo "Recording demo cast against ${API_URL} → ${OUT}"
echo "Press Ctrl+D to stop recording manually if asciinema rec exits the inner shell."

asciinema rec --overwrite --idle-time-limit 1 --command "bash -c '
set -e
echo \"\"
echo \"# Authorize \\\$150.00 USD\"
RESP=\$(curl -s -X POST \"${API_URL}/api/v1/payments/authorize\" \
  -H \"Content-Type: application/json\" \
  -H \"Idempotency-Key: ${KEY_PREFIX}_auth\" \
  -d \"{\\\"amount\\\": ${AMOUNT}, \\\"currency\\\": \\\"USD\\\"}\")
echo \"\$RESP\" | jq .
PAY_ID=\$(echo \"\$RESP\" | jq -r .id)
sleep 1.5

echo \"\"
echo \"# Capture in full\"
curl -s -X POST \"${API_URL}/api/v1/payments/\$PAY_ID/capture\" \
  -H \"Content-Type: application/json\" \
  -H \"Idempotency-Key: ${KEY_PREFIX}_cap\" | jq .
sleep 1.5

echo \"\"
echo \"# Ledger entries — every cent balanced (DEBIT total === CREDIT total)\"
curl -s \"${API_URL}/api/v1/payments/\$PAY_ID/ledger\" | jq .
sleep 2

echo \"\"
echo \"# customer_holds for this payment is now 0 (hold released on capture)\"
curl -s \"${API_URL}/api/v1/accounts/customer_holds/balance\" | jq .

echo \"\"
echo \"# merchant_payable balance = merchant share of \\\$150 minus 3% fee\"
curl -s \"${API_URL}/api/v1/accounts/merchant_payable/balance\" | jq .

echo \"\"
echo \"# Settlement disburses to the merchant\"
curl -s -X POST \"${API_URL}/api/v1/payments/\$PAY_ID/settle\" \
  -H \"Content-Type: application/json\" \
  -H \"Idempotency-Key: ${KEY_PREFIX}_settle\" | jq .
sleep 1.5

echo \"\"
echo \"# merchant_payable now zero — merchant has been paid\"
curl -s \"${API_URL}/api/v1/accounts/merchant_payable/balance\" | jq .
'" "$OUT"

echo ""
echo "Cast saved to ${OUT}."
echo "Upload with: asciinema upload ${OUT}"
echo "Or play locally: asciinema play ${OUT}"
