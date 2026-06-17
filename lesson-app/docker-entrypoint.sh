#!/bin/sh
set -e
if [ -n "$LESSON_PERSIST_DIR" ]; then
  mkdir -p "$LESSON_PERSIST_DIR/assets" "$LESSON_PERSIST_DIR/outputs" "$LESSON_PERSIST_DIR/data"
fi
exec "$@"
