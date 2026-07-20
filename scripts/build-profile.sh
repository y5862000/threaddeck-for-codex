#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PARENT="$ROOT_DIR/profiles/source/unpacked"
SOURCE_PROFILE="$SOURCE_PARENT/BD0CCFE2-385C-472C-A7A9-57205644D475.sdProfile"
OUTPUT_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin/profiles"
OUTPUT="$OUTPUT_DIR/threaddeck-neo.streamDeckProfile"

mkdir -p "$OUTPUT_DIR"
for existing in "$OUTPUT_DIR"/*.streamDeckProfile(N); do
  unlink "$existing"
done

(
  cd "$SOURCE_PARENT"
  /usr/bin/zip -X -q -r "$OUTPUT" "$(basename "$SOURCE_PROFILE")"
)
