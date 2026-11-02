#!/bin/sh
# Standalone corresponding-source build recipe. No source patches are applied.
# Usage: /bin/sh build-media-tools.sh SOURCES EMPTY_WORK OUTPUT arm64|x64
set -eu
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C LANG=C MACOSX_DEPLOYMENT_TARGET=14.0
unset CFLAGS CPPFLAGS LDFLAGS CXXFLAGS CPATH LIBRARY_PATH SDKROOT
sources=$1
work=$2
output=$3
arch=$4
case "$arch" in
  arm64) host=aarch64-apple-darwin; cpu=arm64 ;;
  x64) host=x86_64-apple-darwin; cpu=x86_64 ;;
  *) exit 1 ;;
esac
test "$(uname -s)" = Darwin
test "$(uname -m)" = "$cpu"
for directory in "$sources" "$work" "$output"; do
  case "$directory" in /*) ;; *) printf '%s\n' 'Absolute source/work/output paths required' >&2; exit 1 ;; esac
done
test ! -e "$work"
# The distributed standalone recipe enforces the same source bytes as the host.
test "$(/usr/bin/shasum -a 256 "$sources/ffmpeg-7.1.5.tar.xz" | cut -d ' ' -f 1)" = de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
test "$(/usr/bin/shasum -a 256 "$sources/x264-b35605a.tar" | cut -d ' ' -f 1)" = 97011e241beb7322b21643d3c029b15d7d81018ae0332a44d1578ee11df00475
mkdir -p "$work/x264" "$work/ffmpeg" "$work/prefix" "$output/build-info" "$output/licenses"
tar -xf "$sources/x264-b35605a.tar" -C "$work/x264" --strip-components 1
tar -xf "$sources/ffmpeg-7.1.5.tar.xz" -C "$work/ffmpeg" --strip-components 1
export CC=/usr/bin/clang
export X264_PREFIX="$work/prefix"
# Disable assembly on both architectures: baseline portable C, no nasm dependency,
# no native CPU tuning and no accidental Rosetta/cross-architecture substitution.
cd "$work/x264"
/bin/sh ./configure --prefix="$X264_PREFIX" --host="$host" --enable-static --disable-cli --disable-opencl --disable-asm --disable-avs --disable-swscale --disable-lavf --disable-ffms --enable-pic
make -j4
make install-lib-static
cp config.mak "$output/build-info/x264-config.mak"
cp COPYING "$output/licenses/x264-COPYING"
cd "$work/ffmpeg"
/bin/sh ./configure --prefix="$work/install" --cc=/usr/bin/clang --arch="$cpu" --target-os=darwin \
  --pkg-config="$sources/media-tools-pkg-config.sh" --pkg-config-flags=--static \
  --disable-autodetect --disable-everything --disable-network --disable-nonfree \
  --enable-gpl --enable-libx264 --enable-static --disable-shared --disable-asm \
  --disable-doc --disable-debug --disable-ffplay --enable-ffmpeg --enable-ffprobe \
  --enable-protocol=file,pipe --enable-demuxer=mov,matroska,concat \
  --enable-muxer=mp4,mov,ipod,image2,null \
  --enable-decoder=h264,hevc,vp8,vp9,mpeg4,mjpeg,aac,mp3,opus,vorbis,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,wrapped_avframe \
  --enable-parser=h264,hevc,vp8,vp9,mpeg4video,mjpeg,aac,mpegaudio,opus,vorbis \
  --enable-encoder=libx264,aac,mjpeg,wrapped_avframe,pcm_s16le \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc \
  --enable-indev=lavfi \
  --enable-filter=scale,pad,setsar,fps,format,select,metadata,trim,setpts,anullsrc,apad,atrim,asetpts,aresample,aformat,anull,null,testsrc2,sine
make -j4
cp ffmpeg ffprobe "$output/"
cp ffbuild/config.mak "$output/build-info/ffmpeg-config.mak"
cp config.h "$output/build-info/ffmpeg-config.h"
cp COPYING.GPLv2 COPYING.LGPLv2.1 LICENSE.md "$output/licenses/"
/usr/bin/clang --version > "$output/build-info/compiler.txt"
/usr/bin/xcrun --show-sdk-version > "$output/build-info/sdk.txt"
"$output/ffmpeg" -version > "$output/build-info/ffmpeg-version.txt"
"$output/ffprobe" -version > "$output/build-info/ffprobe-version.txt"
