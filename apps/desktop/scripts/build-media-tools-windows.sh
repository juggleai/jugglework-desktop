#!/bin/sh
# Corresponding-source Windows cross-build. Requires llvm-mingw and Git MSYS.
# Usage: bash build-media-tools-windows.sh SOURCES EMPTY_WORK OUTPUT x64|arm64 TOOLCHAIN
set -eu
sources=$1
work=$2
output=$3
arch=$4
toolchain=$5
export PATH="$toolchain/bin:/usr/bin:/bin"
export LC_ALL=C LANG=C
unset CFLAGS CPPFLAGS LDFLAGS CXXFLAGS CPATH LIBRARY_PATH
case "$arch" in
  x64) host=x86_64-w64-mingw32; cpu=x86_64 ;;
  arm64) host=aarch64-w64-mingw32; cpu=aarch64 ;;
  *) exit 1 ;;
esac
test ! -e "$work"
test "$(sha256sum "$sources/ffmpeg-7.1.5.tar.xz" | cut -d ' ' -f 1)" = de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
test "$(sha256sum "$sources/x264-b35605a.tar" | cut -d ' ' -f 1)" = 97011e241beb7322b21643d3c029b15d7d81018ae0332a44d1578ee11df00475
mkdir -p "$work/x264" "$work/ffmpeg" "$work/prefix" "$output/build-info" "$output/licenses"
tar -xf "$sources/x264-b35605a.tar" -C "$work/x264" --strip-components 1
/c/Windows/System32/tar.exe -xf "$(cygpath -w "$sources/ffmpeg-7.1.5.tar.xz")" -C "$(cygpath -w "$work/ffmpeg")" --strip-components 1
export CC="$host-clang" AR="$host-ar" RANLIB="$host-ranlib"
export X264_PREFIX="$work/prefix"
cd "$work/x264"
sh ./configure --prefix="$X264_PREFIX" --host="$host" --cross-prefix="$host-" --enable-static --disable-cli --disable-opencl --disable-asm --disable-avs --disable-swscale --disable-lavf --disable-ffms --extra-ldflags=-static
mingw32-make -j4 SHELL=/bin/sh V=1
mingw32-make SHELL=/bin/sh install-lib-static
cp config.mak "$output/build-info/x264-config.mak"
cp COPYING "$output/licenses/x264-COPYING"
cd "$work/ffmpeg"
sh ./configure --prefix="$work/install" --cc="$CC" --arch="$cpu" --target-os=mingw32 --enable-cross-compile --cross-prefix="$host-" \
  --pkg-config="$sources/media-tools-pkg-config.sh" --pkg-config-flags=--static --extra-ldflags=-static \
  --disable-autodetect --disable-everything --disable-network --disable-nonfree \
  --enable-gpl --enable-libx264 --enable-static --disable-shared --disable-asm \
  --disable-doc --disable-debug --disable-ffplay --enable-ffmpeg --enable-ffprobe \
  --enable-protocol=file,pipe --enable-demuxer=mov,matroska,concat \
  --enable-muxer=mp4,mov,ipod,image2,null \
  --enable-decoder=h264,hevc,vp8,vp9,mpeg4,mjpeg,aac,mp3,opus,vorbis,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,wrapped_avframe \
  --enable-parser=h264,hevc,vp8,vp9,mpeg4video,mjpeg,aac,mpegaudio,opus,vorbis \
  --enable-encoder=libx264,aac,mjpeg,wrapped_avframe,pcm_s16le \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc --enable-indev=lavfi \
  --enable-filter=scale,pad,setsar,fps,format,select,metadata,trim,setpts,anullsrc,apad,atrim,asetpts,aresample,aformat,anull,null,testsrc2,sine
mingw32-make -j4 SHELL=/bin/sh V=1
cp ffmpeg.exe ffprobe.exe "$output/"
cp ffbuild/config.mak "$output/build-info/ffmpeg-config.mak"
cp config.h "$output/build-info/ffmpeg-config.h"
cp COPYING.GPLv2 COPYING.LGPLv2.1 LICENSE.md "$output/licenses/"
"$CC" --version > "$output/build-info/compiler.txt"
printf '%s\n' 'llvm-mingw UCRT; Windows system import libraries (no Microsoft SDK used)' > "$output/build-info/sdk.txt"
