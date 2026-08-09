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

node scripts/release-version.mjs check

release_tag="${RELEASE_TAG:-}"
if [[ -z "${release_tag}" ]]; then
	package_version="$(node -p "require('./packages/core/package.json').version")"
	release_tag="v${package_version}"
fi

policy_output="$(node scripts/release-version.mjs parse "${release_tag}")"
release_version=""
dist_tag=""
prerelease=""
attestation=""
attestation_path=""
while IFS='=' read -r key value; do
	case "${key}" in
		release-version) release_version="${value}" ;;
		dist-tag) dist_tag="${value}" ;;
		prerelease) prerelease="${value}" ;;
		attestation) attestation="${value}" ;;
		attestation-path) attestation_path="${value}" ;;
	esac
done <<< "${policy_output}"

if [[ -z "${release_version}" || -z "${dist_tag}" || -z "${prerelease}" || -z "${attestation}" || -z "${attestation_path}" ]]; then
	echo "Release tag preflight failed: release policy parser returned incomplete output." >&2
	exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
	printf '%s\n' "${policy_output}" >> "${GITHUB_OUTPUT}"
fi

if [[ "${attestation}" == "required" ]]; then
	if [[ ! -f "${attestation_path}" ]]; then
		echo "Release tag preflight failed: stable release attestation is missing: ${attestation_path}" >&2
		exit 1
	fi
	pnpm run eval:release -- verify --report "${attestation_path}"
elif [[ "${attestation}" == "not_required" ]]; then
	echo "Release evaluation attestation not_required for recognized ${dist_tag} prerelease ${release_version}."
else
	echo "Release tag preflight failed: unsupported attestation policy '${attestation}'." >&2
	exit 1
fi

echo "Release tag preflight passed for commit ${tag_commit} on ${qualified_branch:-${EXPECTED_BRANCH}}."
