#!/bin/sh
# Isolated x264-only pkg-config adapter; never discover host-installed libraries.
set -eu
if [ "$*" = "--version" ]; then printf '%s\n' '1.0'; exit 0; fi
case "$*" in
  *x264*) ;;
  *) exit 1 ;;
esac
case "$*" in
  *--exists*) exit 0 ;;
  *--cflags*) printf '%s\n' "-I${X264_PREFIX}/include" ;;
  *--libs*) printf '%s\n' "-L${X264_PREFIX}/lib -lx264 -lpthread -lm" ;;
  *--modversion*) printf '%s\n' '0.165' ;;
  *) exit 1 ;;
esac
