#!/usr/bin/env bash
set -euo pipefail

fail() {
	echo "Release tag preflight failed: $*" >&2
	exit 1
}

# Resolve only the branch fetched by this invocation. A stale origin/* ref
# must never authorize a release after its remote branch has been deleted.
fetch_branch_commit() {
	git fetch --no-tags origin "refs/heads/$1" --quiet || return 1
	git rev-parse 'FETCH_HEAD^{commit}'
}

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
	TARGET_COMMIT="${RELEASE_TAG_COMMIT:-${GITHUB_SHA:-HEAD}}"
else
	TARGET_COMMIT="HEAD"
	current_branch="$(git branch --show-current)"
	if [[ "$current_branch" != "main" && ! "$current_branch" =~ ^release/[0-9]+\.[0-9]+$ ]]; then
		fail "current branch is '${current_branch}', expected main or release/X.Y."
	fi
	[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail "working tree is not clean."
fi

tag_commit="$(git rev-parse "${TARGET_COMMIT}^{commit}")"
maintenance_branch=""
if [[ -n "${RELEASE_TAG:-}" || "${current_branch:-}" == release/* ]]; then
	package_version="$(git show "${tag_commit}:packages/core/package.json" | node -e '
		let input = "";
		process.stdin.on("data", chunk => input += chunk);
		process.stdin.on("end", () => {
			const version = JSON.parse(input).version;
			if (typeof version !== "string") process.exit(1);
			process.stdout.write(version);
		});
	')"
	candidate_version="$package_version"
	if [[ -n "${RELEASE_TAG:-}" ]]; then
		[[ "$RELEASE_TAG" == v* ]] || fail "RELEASE_TAG must start with v."
		candidate_version="${RELEASE_TAG#v}"
		[[ "$candidate_version" == "$package_version" ]] || fail "RELEASE_TAG version does not match packages/core/package.json at the tag target."
	fi
	[[ "$candidate_version" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+(-[A-Za-z0-9.+-]+)?$ ]] || fail "invalid release version '${candidate_version}'."
	maintenance_branch="release/${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
fi

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
	main_commit="$(fetch_branch_commit main)" || fail "could not fetch origin/main."
	if git merge-base --is-ancestor "$tag_commit" "$main_commit"; then
		echo "Release tag preflight passed for commit ${tag_commit} on main."
		exit 0
	fi
	[[ -n "${RELEASE_TAG:-}" ]] || fail "RELEASE_TAG is required for maintenance releases in CI."
	maintenance_commit="$(fetch_branch_commit "$maintenance_branch")" || fail "could not fetch origin/${maintenance_branch}."
	git merge-base --is-ancestor "$tag_commit" "$maintenance_commit" || fail "tag commit is not reachable from origin/main or origin/${maintenance_branch}."
	echo "Release tag preflight passed for commit ${tag_commit} on ${maintenance_branch}."
	exit 0
fi

if [[ "$current_branch" != "main" && "$current_branch" != "$maintenance_branch" ]]; then
	fail "current branch '${current_branch}' does not match version series '${maintenance_branch}'."
fi
remote_commit="$(fetch_branch_commit "$current_branch")" || fail "could not fetch origin/${current_branch}."
[[ "$tag_commit" == "$remote_commit" ]] || fail "local tag target is not origin/${current_branch} HEAD."
echo "Release tag preflight passed for commit ${tag_commit} on ${current_branch}."
