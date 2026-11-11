#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Build the pinned ByteVC2 decoder with MSYS2 UCRT64 GCC.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(cd "$1" && pwd)
build=$(mktemp -d "$work/build.XXXXXXXX")
prefix="$build/x264-install"
export PATH="$build/tools/usr/bin:/ucrt64/bin:/usr/bin:$PATH"
export CC=gcc CXX=g++

mkdir -p "$build/x264" "$build/ffmpeg" "$build/tools"
tar -xf "$work/pkgconf.tar.zst" -C "$build/tools" usr/bin/pkgconf.exe usr/bin/msys-pkgconf-8.dll
tar -xzf "$work/x264.tar.gz" -C "$build/x264" --strip-components=1
tar -xzf "$work/ffmpeg.tar.gz" -C "$build/ffmpeg" --strip-components=1

jobs=${MAKE_JOBS:-8}
(cd "$build/x264" && ./configure --prefix="$prefix" --enable-static --disable-cli --disable-asm && make -j"$jobs" && make install)

cd "$build/ffmpeg"
# Keep patch paths relative to FFmpeg even when the build cache sits inside a Git checkout.
git init -q
sed 's/\r$//' "$repo/vendor/bytevc2/0001-add-bvc2-decoder.patch" | git apply -
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
./configure --cc=gcc --cxx=g++ --pkg-config=pkgconf \
  --disable-everything --disable-doc --disable-debug --disable-autodetect --disable-asm \
  --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-static --disable-shared \
  --enable-protocol=file,pipe --enable-demuxer=mov --enable-muxer=mp4 \
  --enable-decoder=bvc2,aac --enable-encoder=libx264,aac --enable-libx264 \
  --enable-filter=scale,format,aresample --enable-gpl --enable-version3 \
  --pkg-config-flags=--static --extra-ldflags=-static
make -j"$jobs" ffmpeg.exe
./ffmpeg.exe -hide_banner -decoders | grep ' bvc2 '
cp ffmpeg.exe "$work/ffmpeg.exe"
cp COPYING.GPLv3 "$work/FFmpeg-LICENSE.txt"
cp "$build/x264/COPYING" "$work/x264-LICENSE.txt"
