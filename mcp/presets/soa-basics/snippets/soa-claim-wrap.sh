#!/usr/bin/env bash
# Run a command while holding a soa-work claim; always release.
#   soa-claim-wrap <scope> <command…>
# Exits 3 without running anything if another agent holds an overlapping claim.
set -u
scope="$1"; shift
if ! soa-work check "$scope"; then
  echo "scope is claimed by another agent; not running" >&2
  exit 3
fi
soa-work claim "$scope" --ttl 30m --note "$*" || exit 1
trap 'soa-work release "$scope" >/dev/null 2>&1' EXIT INT TERM
"$@"
