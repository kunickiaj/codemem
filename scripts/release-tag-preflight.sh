#!/usr/bin/env bash
set -euo pipefail

EXPECTED_BRANCH="${RELEASE_EXPECTED_BRANCH:-main}"
MAIN_REF="origin/${EXPECTED_BRANCH}"
TARGET_COMMIT="${RELEASE_TAG_COMMIT:-${GITHUB_SHA:-HEAD}}"

git fetch origin "${EXPECTED_BRANCH}" --quiet

main_commit="$(git rev-parse "${MAIN_REF}^{commit}")"
tag_commit="$(git rev-parse "${TARGET_COMMIT}^{commit}")"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
	if ! git merge-base --is-ancestor "${tag_commit}" "${main_commit}"; then
		echo "Release tag preflight failed: tag commit is not reachable from origin/${EXPECTED_BRANCH}." >&2
		echo "  tag commit:  ${tag_commit}" >&2
		echo "  main commit: ${main_commit}" >&2
		echo "Tag only after the release commit is merged to ${EXPECTED_BRANCH}." >&2
		exit 1
	fi
elif [[ "${tag_commit}" != "${main_commit}" ]]; then
	echo "Release tag preflight failed: local tag target is not origin/${EXPECTED_BRANCH} HEAD." >&2
	echo "  tag commit:  ${tag_commit}" >&2
	echo "  main commit: ${main_commit}" >&2
	echo "Tag from updated ${EXPECTED_BRANCH} after the release PR merge commit is at HEAD." >&2
	exit 1
fi

if [[ -z "${GITHUB_ACTIONS:-}" && "${RELEASE_SKIP_LOCAL_GUARDS:-0}" != "1" ]]; then
	current_branch="$(git branch --show-current || true)"
	if [[ "${current_branch}" != "${EXPECTED_BRANCH}" ]]; then
		echo "Release tag preflight failed: current branch is '${current_branch}', expected '${EXPECTED_BRANCH}'." >&2
		exit 1
	fi

	if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
		echo "Release tag preflight failed: working tree is not clean." >&2
		exit 1
	fi
fi

echo "Release tag preflight passed for commit ${tag_commit}."
