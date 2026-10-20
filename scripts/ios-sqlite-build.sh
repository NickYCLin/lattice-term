#!/bin/sh
set -eu

: "${SDKROOT:?Xcode SDKROOT is required}"
if [ ! -f "$SDKROOT/usr/include/sqlite3.h" ]; then
  echo "SQLite header is missing from the selected Xcode SDK" >&2
  exit 1
fi

export SQLITE3_INCLUDE_DIR="$SDKROOT/usr/include"
export SQLITE3_LIB_DIR="$SDKROOT/usr/lib"
export PKG_CONFIG_LIBDIR="$SDKROOT/usr/lib/pkgconfig"
export LIBSQLITE3_SYS_USE_PKG_CONFIG=1
export SQLITE3_STATIC=0
export BINDGEN_EXTRA_CLANG_ARGS="${BINDGEN_EXTRA_CLANG_ARGS:-} -isysroot \"$SDKROOT\""
exec "$@"
