#!/usr/bin/env bash
set -euo pipefail

EXPECTED_BRANCH="${RELEASE_EXPECTED_BRANCH:-main}"
MAIN_REF="origin/${EXPECTED_BRANCH}"
TARGET_COMMIT="${RELEASE_TAG_COMMIT:-${GITHUB_SHA:-HEAD}}"

git fetch origin "${EXPECTED_BRANCH}" --quiet
git fetch origin 'refs/heads/release/*:refs/remotes/origin/release/*' --quiet || true

main_commit="$(git rev-parse "${MAIN_REF}^{commit}")"
tag_commit="$(git rev-parse "${TARGET_COMMIT}^{commit}")"

matches_main=0
if git merge-base --is-ancestor "${tag_commit}" "${main_commit}"; then
	matches_main=1
fi

matching_release_branches=()
while IFS= read -r branch_ref; do
	[[ -z "${branch_ref}" ]] && continue
	if git merge-base --is-ancestor "${tag_commit}" "${branch_ref}"; then
		matching_release_branches+=("${branch_ref#origin/}")
	fi
done < <(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/release/*')

qualified_branch=""
if [[ "${matches_main}" -eq 1 ]]; then
	qualified_branch="${EXPECTED_BRANCH}"
elif [[ "${#matching_release_branches[@]}" -eq 1 ]]; then
	qualified_branch="${matching_release_branches[0]}"
fi

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
	if [[ -z "${qualified_branch}" ]]; then
		echo "Release tag preflight failed: tag commit is not reachable from origin/${EXPECTED_BRANCH} or an origin/release/* branch." >&2
		echo "  tag commit:  ${tag_commit}" >&2
		echo "  main commit: ${main_commit}" >&2
		if [[ "${#matching_release_branches[@]}" -gt 1 ]]; then
			echo "  matching release branches: ${matching_release_branches[*]}" >&2
		fi
		echo "Tag only after the release commit is merged to ${EXPECTED_BRANCH} or a single release branch." >&2
		exit 1
	fi
	if [[ "${qualified_branch}" == "${EXPECTED_BRANCH}" && "${tag_commit}" != "${main_commit}" ]]; then
		echo "Release tag preflight passed for commit ${tag_commit} on ${qualified_branch}."
		exit 0
	fi
	if [[ "${qualified_branch}" != "${EXPECTED_BRANCH}" ]]; then
		echo "Release tag preflight passed for commit ${tag_commit} on ${qualified_branch}."
		exit 0
	fi
	if [[ "${tag_commit}" != "${main_commit}" ]]; then
		echo "Release tag preflight failed: local tag target is not origin/${EXPECTED_BRANCH} HEAD." >&2
		echo "  tag commit:  ${tag_commit}" >&2
		echo "  main commit: ${main_commit}" >&2
		echo "Tag from updated ${EXPECTED_BRANCH} after the release PR merge commit is at HEAD." >&2
		exit 1
	fi
	elif [[ -z "${qualified_branch}" ]]; then
	echo "Release tag preflight failed: local tag target is not on origin/${EXPECTED_BRANCH} or a single origin/release/* branch." >&2
	echo "  tag commit:  ${tag_commit}" >&2
	echo "  main commit: ${main_commit}" >&2
	if [[ "${#matching_release_branches[@]}" -gt 1 ]]; then
		echo "  matching release branches: ${matching_release_branches[*]}" >&2
	fi
	exit 1
fi

if [[ -z "${GITHUB_ACTIONS:-}" && "${RELEASE_SKIP_LOCAL_GUARDS:-0}" != "1" ]]; then
	current_branch="$(git branch --show-current || true)"
	if [[ -n "${qualified_branch}" && "${current_branch}" != "${qualified_branch}" ]]; then
		echo "Release tag preflight failed: current branch is '${current_branch}', expected '${qualified_branch}'." >&2
		exit 1
	fi

	if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
		echo "Release tag preflight failed: working tree is not clean." >&2
		exit 1
	fi
fi

echo "Release tag preflight passed for commit ${tag_commit} on ${qualified_branch:-${EXPECTED_BRANCH}}."
