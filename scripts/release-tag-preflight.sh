#!/usr/bin/env bash
set -euo pipefail

EXPECTED_BRANCH="main"
MAIN_REF="origin/${EXPECTED_BRANCH}"
package_version="$(node -p 'require("./packages/core/package.json").version')"
release_tag="${RELEASE_TAG:-v${package_version}}"
if [[ "${release_tag}" != "v${package_version}" ]]; then
	echo "Release tag preflight failed: tag '${release_tag}' does not match a valid package version '${package_version}'." >&2
	exit 1
fi
if [[ ! "${release_tag}" =~ ^v([0-9]+)\.([0-9]+)\.[0-9]+(-[A-Za-z0-9.+-]+)?$ ]]; then
	echo "Release tag preflight failed: invalid tag '${release_tag}'." >&2
	exit 1
fi
maintenance_branch="release/${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
maintenance_ref="origin/${maintenance_branch}"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
	TARGET_COMMIT="${RELEASE_TAG_COMMIT:-${GITHUB_SHA:-HEAD}}"
else
	TARGET_COMMIT="HEAD"
fi

git fetch origin "${EXPECTED_BRANCH}" --quiet
maintenance_commit=""
if git fetch origin "refs/heads/${maintenance_branch}:refs/remotes/${maintenance_ref}" --quiet 2>/dev/null; then
	maintenance_commit="$(git rev-parse "${maintenance_ref}^{commit}")"
fi

main_commit="$(git rev-parse "${MAIN_REF}^{commit}")"
tag_commit="$(git rev-parse "${TARGET_COMMIT}^{commit}")"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
	if git merge-base --is-ancestor "${tag_commit}" "${main_commit}"; then
		echo "Release tag preflight passed for commit ${tag_commit} on ${EXPECTED_BRANCH}."
		exit 0
	fi
	if [[ -z "${maintenance_commit}" || "${tag_commit}" != "${maintenance_commit}" ]]; then
		echo "Release tag preflight failed: tag commit is neither on origin/${EXPECTED_BRANCH} nor the head of ${maintenance_ref}." >&2
		echo "  tag commit:  ${tag_commit}" >&2
		echo "  main commit: ${main_commit}" >&2
		exit 1
	fi
	echo "Release tag preflight passed for commit ${tag_commit} on ${maintenance_branch}."
	exit 0
fi

current_branch="$(git branch --show-current || true)"
if [[ "${current_branch}" == "${EXPECTED_BRANCH}" ]]; then
	expected_commit="${main_commit}"
elif [[ "${current_branch}" == "${maintenance_branch}" && -n "${maintenance_commit}" ]]; then
	expected_commit="${maintenance_commit}"
else
	echo "Release tag preflight failed: current branch is '${current_branch}', expected '${EXPECTED_BRANCH}' or a pushed '${maintenance_branch}'." >&2
	exit 1
fi

if [[ "${tag_commit}" != "${expected_commit}" ]]; then
	echo "Release tag preflight failed: local tag target is not origin/${current_branch} HEAD." >&2
	echo "  tag commit:  ${tag_commit}" >&2
	echo "  branch commit: ${expected_commit}" >&2
	exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
	echo "Release tag preflight failed: working tree is not clean." >&2
	exit 1
fi

echo "Release tag preflight passed for commit ${tag_commit} on ${current_branch}."
