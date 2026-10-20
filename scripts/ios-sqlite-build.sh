#!/bin/sh
set -eu

: "${SDKROOT:?Xcode SDKROOT is required}"
if [ ! -f "$SDKROOT/usr/include/sqlite3.h" ]; then
  echo "SQLite header is missing from the selected Xcode SDK" >&2
  exit 1
fi

export SQLITE3_INCLUDE_DIR="$SDKROOT/usr/include"
export SQLITE3_LIB_DIR="$SDKROOT/usr/lib"
export BINDGEN_EXTRA_CLANG_ARGS="${BINDGEN_EXTRA_CLANG_ARGS:-} -isysroot \"$SDKROOT\""
exec "$@"
