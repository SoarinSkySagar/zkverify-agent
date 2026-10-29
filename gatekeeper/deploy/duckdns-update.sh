#!/bin/sh
# Points DUCKDNS_DOMAIN at this machine's public IP (DuckDNS detects it from the request).
#   once:  DUCKDNS_DOMAIN=... DUCKDNS_TOKEN=... sh duckdns-update.sh
#   loop:  sh duckdns-update.sh --loop        (every 5 minutes; used by docker-compose)
# The token is never printed: curl's output and the URL are kept off the log.
set -u

: "${DUCKDNS_DOMAIN:?DUCKDNS_DOMAIN is required}"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN is required}"

update() {
  result=$(curl -fsS --max-time 20 \
    "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=" 2>/dev/null)
  if [ "$result" = "OK" ]; then
    echo "$(date -u +%FT%TZ) duckdns: updated ${DUCKDNS_DOMAIN}"
  else
    echo "$(date -u +%FT%TZ) duckdns: update FAILED for ${DUCKDNS_DOMAIN} (check domain/token)" >&2
    return 1
  fi
}

if [ "${1:-}" = "--loop" ]; then
  while :; do
    update
    sleep 300
  done
else
  update
fi
