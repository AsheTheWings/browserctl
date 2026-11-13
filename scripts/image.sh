#!/bin/sh
# Builds the container image and publishes it with its OCI annotations.
#
# usage: scripts/image.sh build <layout-dir> <revision> <created>
#        scripts/image.sh push <layout-dir> <revision> <created> <source> <run-url> (--oci-layout <dir> | <reference>)
#
# build writes the image to an OCI layout directory with podman. push writes
# that image's config and layers, annotated with the revision, source, run
# URL, creation time, and version, as one manifest: to another OCI layout
# with --oci-layout, or to a registry reference, reading the registry token
# on standard input. It prints the manifest digest. The same layout and
# arguments always produce the same digest. ORAS names the oras executable.
set -eu

usage() {
	sed -n '4,5p' "$0" >&2
	exit 2
}

version=0.0.0
local_tag=qualified

[ "$#" -ge 1 ] || usage
command=$1
shift
cd "$(dirname "$0")/.."

case "$command" in
build)
	[ "$#" -eq 3 ] || usage
	layout=$1 revision=$2 created=$3
	epoch=$(date -u -d "$created" +%s)
	tag="localhost/browserctl-build:$revision"
	podman build --format oci --timestamp "$epoch" \
		--build-arg VERSION="$version" --build-arg COMMIT="$revision" \
		-t "$tag" .
	podman save --format oci-dir -o "$layout" "$tag" >/dev/null
	podman rmi "$tag" >/dev/null
	;;
push)
	[ "$#" -ge 6 ] || usage
	layout=$1 revision=$2 created=$3 source=$4 run_url=$5
	shift 5
	: "${ORAS:?ORAS must name the oras executable}"
	manifest=$(jq -r '.manifests | if length == 1 then .[0].digest else error("one image expected") end' "$layout/index.json")
	blobs="$layout/blobs/sha256"
	config=$(jq -r '.config | "\(.digest | ltrimstr("sha256:")):\(.mediaType)"' "$blobs/${manifest#sha256:}")
	layers=$(jq -r '.layers[] | "\(.digest | ltrimstr("sha256:")):\(.mediaType)"' "$blobs/${manifest#sha256:}")
	case "$1" in
	--oci-layout)
		[ "$#" -eq 2 ] || usage
		destination=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
		set -- --oci-layout "$destination:$local_tag"
		;;
	*)
		[ "$#" -eq 1 ] || usage
		: "${ORAS_REGISTRY_CONFIG:?ORAS_REGISTRY_CONFIG must name a run-owned registry config file}"
		set -- -u oidc --password-stdin --registry-config "$ORAS_REGISTRY_CONFIG" "$1"
		;;
	esac
	cd "$blobs"
	# shellcheck disable=SC2086 # each layer is one word
	"$ORAS" push --format 'go-template={{.digest}}' --config "$config" \
		--annotation "org.opencontainers.image.created=$created" \
		--annotation "org.opencontainers.image.revision=$revision" \
		--annotation "org.opencontainers.image.source=$source" \
		--annotation "org.opencontainers.image.url=$run_url" \
		--annotation "org.opencontainers.image.version=$version" \
		"$@" $layers
	echo
	;;
*)
	usage
	;;
esac
