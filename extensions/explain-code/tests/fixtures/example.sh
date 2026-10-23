#!/usr/bin/env bash
set -euo pipefail
for file in "$@"; do
  printf '%s\n' "$file"
done
