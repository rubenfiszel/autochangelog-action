# autochangelog

Generates a changelog file and bump a manifest file version (file which contains contents either in json or yaml) based on the changes since last released tag.

## Introduction

This Github action takes the following assumptions:

- The commit history of the master branch mostly respect the [conventional commit format](https://www.conventionalcommits.org/en/v1.0.0/). The action will still makes sense if it is partially or even not respected all, but it will not be able to do the proper next semantic version inference as well as pretty printing the changes in the changelog.
- You have a _manifest_ file which is either YAML or JSON that has version as one of its top field.
- You have a _changelog_ file in markdown in which you want to append

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
    default: './manifest.yml'
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

## Example Setup

```yaml
name: autochangelog

on:
  push:
    branches:    
      - master
      - 'releases/**' 

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
        uses: rubenfiszel/autochangelog-action@v0.7.0
        with:
          changelog_file: './CHANGELOG.md'
          manifest_file: './manifest.yml'
          dry_run: false
          issues_url_prefix: 'https://MY_REPO_URL_PREFIX.com/issues'
          tag_prefix: 'v'
      - name: Create Pull Request
        id: cpr
        uses: peter-evans/create-pull-request@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          commit-message: 'Update changelog and manifest'
          title: 'ci: Release ${{ steps.ac.outputs.version }}'
          body: |
            Release v${{ steps.ac.outputs.version }}
          labels: autorelease
          branch: automatic-release-prs
          branch-suffix: none
      - name: Check outputs
        run: |
          echo "Pull Request Number - ${{ env.PULL_REQUEST_NUMBER }}"
          echo "Pull Request Number - ${{ steps.cpr.outputs.pr_number }}"
```

## Workflow

Whenever a push to master is done, this action should get triggered and maintain a PR in stand-by with the changelog and version bump.
That PR can be labelled with `autorelease` and another workflow can then automatically trigger a release.

For instance:


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
          | xargs -i echo "::set-output name=version::{}"
      - name: get changelog
        id: changelog 
        run: |
          changelog=$(echo "${{ steps.version.outputs.version}}" \
          | xargs -i sed -n '/^#\s\'"{}"'.*$/,/^#\s\([^[:space:]]\+\).*$/{//!p}' ${{ env.changelog_file }})
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

## Local Dev Setup

One way to iterate over the features here is to set the `const debug` to true and run the script locally after compilation: `node lib/main.js`

## Dependency Philosophy

This action is very dependency light, only:

- `"@actions/core": "^1.2.0"`
- `"simple-git": "^1.129.0"`
- `"util": "^0.12.1"`
- `"yaml": "^1.7.2"`

It would be desirable to keep it this way by making sure most simple logic are reimplemented if needed.