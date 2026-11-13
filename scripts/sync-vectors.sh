#!/usr/bin/env sh
#
# Copies Go tronc's conformance vectors into testdata/vectors and records the tag they came from.
#
#   sh scripts/sync-vectors.sh v0.22.2                    clone FacileStudio/tronc at a release tag
#   sh scripts/sync-vectors.sh ~/Code/Facile/tronc        read a local checkout
#
# testdata/vectors/SOURCE holds the tag. CI re-runs this against it and fails on a diff:
#
#   sh scripts/sync-vectors.sh "$(cat testdata/vectors/SOURCE)" && git diff --exit-code testdata/vectors

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <tag|checkout>" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
target="$root/testdata/vectors"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

if [ -d "$1/conformance/vectors" ]; then
  from="$1/conformance/vectors"
  tag="$(git -C "$1" describe --tags --exact-match 2>/dev/null || git -C "$1" rev-parse --short HEAD)"
else
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$1" https://github.com/FacileStudio/tronc "$scratch/tronc"
  from="$scratch/tronc/conformance/vectors"
  tag="$1"
fi

set -- "$from"/*.json
if [ ! -f "$1" ]; then
  echo "sync-vectors: no vector file in $from" >&2
  exit 1
fi

mkdir -p "$target"
rm -f "$target"/*.json
cp "$@" "$target/"
echo "$tag" > "$target/SOURCE"
echo "sync-vectors: $# files from $tag"
