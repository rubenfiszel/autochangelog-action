# autochangelog

Generates a changelog file (or append to existing) and bumps the version in a manifest file. The manifest file can be `package.json` in the npm world, or any JSON/YAML file. The next version is inferred based on the changes since last released tag.

Note that changes must follow [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) specs.

## Introduction

This Github action takes the following assumptions:

- The commit history of the master branch mostly respect the [conventional commit format](https://www.conventionalcommits.org/en/v1.0.0/). The action will still makes sense if it is partially or even not respected all, but it will not be able to do the proper next semantic version inference as well as pretty printing the changes in the changelog.
- You have a _manifest_ file which is either YAML or JSON that has version as one of its top-level field.
- You have a _changelog_ file in markdown in which you want to append. If none exists, it generates `CHANGELOG.md` in your root folder.

## Proposed workflow

- Whenever the need arise to do a release, one send a [repository dispatch](https://help.github.com/en/actions/reference/events-that-trigger-workflows#external-events-repository_dispatch) through CURL or other means to trigger this action
- The action generates an output version and changelog diff that can be used to create a PR by combining this action with [create-pull-request](https://github.com/peter-evans/create-pull-request). That same PR can be reviewed and its changelog and version manually curated if needed.
- Once that PR is merged, it creates a Github release with the corresponding version and fill its body with the changelog diff

## Example of generated diff

```diff
iff --git a/CHANGELOG.md b/CHANGELOG.md
index 933a41a9..f455ef34 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,28 @@
+# 1.11.0 - 18-3-2020
+
+## Unclassified Changes
+
+- non conventional commit foo
+
+## Changes
+
+### Bug Fixes
+    
+- fix foo generation ([#218](https://github.com/org/repo/issues/218))
+- address bar security concern([#212](https://github.com/org/repo/issues/212))
+
+### Features
+    
+- add foo([#172](https://github.com/org/repo/issues/172))
+- add bar ([#217](https://github.com/org/repo/issues/217))
+
 # 1.10.0 - 21-2-2020
 
 ## Changes
diff --git a/manifest.yaml b/manifest.yaml
index 310932f4..756d08d9 100644
--- a/manifest.yaml
+++ b/manifest.yaml
@@ -1,2 +1,2 @@
 name: repo
-version: 1.10.0
+version: 1.11.0
```

## Proposed workflow details

### Autochangelog action

```yaml
name: autochangelog

on:
  repository_dispatch:
    types: [autochangelog]

jobs:
  push:
    name: Push Container
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v2
        with:
          fetch-depth: '0'
      - run: git fetch --depth=1 origin +refs/tags/*:refs/tags/*
      - name: autochangelog-action
        id: ac
        uses: rubenfiszel/autochangelog-action@v0.14.0
        with:
          changelog_file: './CHANGELOG.md'
          manifest_file: './manifest.yaml'
          dry_run: false
          issues_url_prefix: 'https://github.com/org/repo/issues/'
          tag_prefix: 'v'
      - name: Create Pull Request
        id: cpr
        uses: peter-evans/create-pull-request@v2
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          commit-message: 'Update changelog and manifest'
          title: 'ci: release ${{ steps.ac.outputs.version }}'
          body: |
            Release [${{ steps.ac.outputs.version }}](https://github.com/org/repo/releases/tag/v${{ steps.ac.outputs.version }})
          labels: autorelease
          branch: automatic-release-prs
          reviewers: your-reviewers-list
      - name: Check outputs
        run: |
          echo "Pull Request Number - ${{ env.PULL_REQUEST_NUMBER }}"
          echo "Pull Request Number - ${{ steps.cpr.outputs.pr_number }}"
```

### Repository dispatch through CURL.

Whenever an event_dispatch is sent(eg: curl):

```
curl -H "Accept: application/vnd.github.everest-preview+json" -H "Authorization: token $GH_TOKEN" --request POST --data '{"event_type": "autochangelog"}' https://api.github.com/repos/org/repo/dispatches
```

this action will get triggered and create a corresponding PR with the changelog and version bump by gathering the changes since last relase.
That PR can be labelled with `autorelease` and another workflow can then automatically trigger a release.

### Autorelease action

```yaml
name: autorelease
on:
  pull_request:
    types: [closed]
    branches:
      - master
jobs:
  build:
    if: github.event.pull_request.merged == true && contains(toJSON(github.event.pull_request.labels.*.name), '"autorelease"')
    runs-on: ubuntu-latest
    env:
      manifest_file: 'manifest.yml'
      changelog_file: 'CHANGELOG.md'
    steps:
      - uses: actions/checkout@v2
        with:
          ref: master
      - name: get version
        id: version
        run: |
          sed -n 's/^version:\s\(.*\)$/\1/p' ${{ env.manifest_file }} \
          | xargs -I {} echo "::set-output name=version::{}"
      - name: get changelog
        id: changelog 
        run: |
          changelog=$(echo "${{ steps.version.outputs.version}}" \
          | xargs -I {} sed -n '/^#\s'"{}"'.*$/,/^#\s\([^[:space:]]\+\).*$/{//!p}' ${{ env.changelog_file }})
          echo $changelog
          changelog="${changelog//'%'/'%25'}"
          changelog="${changelog//$'\n'/'%0A'}"
          changelog="${changelog//$'\r'/'%0D'}"
          echo "::set-output name=changelog::$changelog" 
      - name: echo version and changelog
        run: |
          echo "${{ steps.version.outputs.version}}"
          echo "${{ steps.changelog.outputs.changelog }}"
      - name: Create Release
        uses: ncipollo/release-action@v1.4.0
        with:
          name: ${{ steps.version.outputs.version }}
          tag: v${{ steps.version.outputs.version }}
          body: ${{ steps.changelog.outputs.changelog}}
          draft: false
          prerelease: false
          # An optional tag for the release. If this is omitted the git ref will be used (if it is a tag).
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Behavior

When the action is triggered, it will:

1. read the current version from the manifest file (if it does not exist, assume the version is `0.0.0`)
2. retrieve the commits since last git tag corresponding to that version (with the tag_prefix prefix)
3. infer the next semantic version from the commits respecting the [conventional commit format](https://www.conventionalcommits.org/en/v1.0.0/) and and the pre-1.x convention (breaking changes do not trigger major version bump pre-1.x)
4. generates release notes and append them to the changelog file corresponding to the changes between last and new semantic version
5. bump the version in the manifest file to the new version

## Inputs

```yaml
inputs:
  changelog_file:
    description: 'changelog file path'
    required: false
    default: './CHANGELOG.md'
  manifest_file:
    description: 'manifest file path'
    required: false
    default: './version.yml'
  issues_url_prefix:
    description: 'issues url prefix'
    required: false
    default: ''
  tag_prefix:
    description: 'tag_prefix (used to retrieve commits)'
    required: false
    default: 'v'
  dry_run:
    description: 'do not change files'
    required: false
    default: 'false'
```
## Outputs

```yaml
outputs:
  version:
    description: 'the new version'
```

## Local Dev Setup

One way to iterate over the features here is to set the `const debug` to true and run the script locally after compilation: `node lib/main.js`

## Dependency Philosophy

This action is very dependency light, only:

- `"@actions/core": "^1.2.0"`
- `"simple-git": "^1.129.0"`
- `"util": "^0.12.1"`
- `"yaml": "^1.7.2"`

It would be desirable to keep it this way by making sure most simple logic are reimplemented if needed.
