#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/native/keybridge.m"
OUTPUT_DIR="$ROOT_DIR/com.yechan.threaddeck.sdPlugin/bin"
OUTPUT="$OUTPUT_DIR/keybridge"

mkdir -p "$OUTPUT_DIR"

xcrun --sdk macosx clang \
  -fobjc-arc \
  -Wall \
  -Wextra \
  -Wpedantic \
  -Wunguarded-availability \
  -mmacosx-version-min=13.0 \
  -arch arm64 \
  -arch x86_64 \
  "$SOURCE" \
  -framework ApplicationServices \
  -framework AppKit \
  -framework CoreAudio \
  -framework IOKit \
  -o "$OUTPUT"

chmod 755 "$OUTPUT"
