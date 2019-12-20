import * as core from '@actions/core'
import fs from 'fs'
import YAML from 'yaml'
import utils from 'util'
import * as simplegit from 'simple-git/promise'
import { DefaultLogFields } from 'simple-git/typings/response'

const git = simplegit.default()
const readFileAsync = utils.promisify(fs.readFile)
const writeFileAsync = utils.promisify(fs.writeFile)


interface Version {
  version: string
}

type ManifestType = "json" | "yaml"

const debug = false

async function run(): Promise<void> {
  try {

    const mfFile = debug ? './manifest.yml' : core.getInput('manifest_file')
    const chgFile = debug ? 'CHANGELOG.md' : core.getInput('changelog_file')
    const dryRun = debug ? true : core.getInput('dry_run') === 'true'

    console.log(mfFile, chgFile, dryRun)

    const ext = mfFile.split(".").pop()
    const mfType: ManifestType | undefined =
      ext == "json" ? "json" : (ext == "yaml" || ext == "yml") ? "yaml" : undefined

    const parsedMf: Promise<Version> = readFileAsync(mfFile, 'utf8')
      .then(mfFileContent => {
        if (mfType === "yaml")
          return YAML.parse(mfFileContent)
        else if (mfType === "json")
          return JSON.parse(mfFileContent)
        else
          return null
      })
      .then(version => version ?? <Version>{ version: "0.0.0" })
      .catch(e => <Version>{ version: "0.0.0" })


    const newChangelog = await parsedMf.then(obj => getSemanticChangelog(obj.version))
    core.setOutput("version", newChangelog.newVersion)

    const chgPromise = readFileAsync(chgFile, 'utf8')
      .catch(e => "")
      .then(oldChglog => `${stringifyChg(newChangelog)}\n${oldChglog}`)
      .then(chglogStr => {
        console.log("Changelog new content:\n")
        console.log(chglogStr)
        console.log('------')
        if (!dryRun) {
          writeFileAsync(chgFile, chglogStr)
        } else {
          return Promise.resolve()
        }
      })

    const mfPromise = parsedMf
      .then(obj => <Version>{ ...obj, version: newChangelog.newVersion })
      .then(obj => {
        if (mfType === "yaml")
          return YAML.stringify(obj)
        else if (mfType === "json")
          return JSON.stringify(obj, null, 2)
        else
          return ""
      })
      .then(newMfFileContent => {

        console.log("Manifest new content:")
        console.log(newMfFileContent)
        console.log('------')

        if (!dryRun) {
          return writeFileAsync(mfFile, newMfFileContent, 'utf8')
        } else {
          return Promise.resolve()
        }
      })
    Promise.all([chgPromise, mfPromise])
  } catch (error) {
    console.log(error)
    core.setFailed(error.message)
  }
}

interface NonConventionalCommit {
  header: string
  body: string
}

interface ConventionalCommit {
  type: string
  scope?: string
  desc: string
  body?: string
  footers?: string[]
  isBreaking: boolean
  mentions: number[]
}


type Commit = NonConventionalCommit | ConventionalCommit

const typeMap: { [type: string]: TypeValue } = {
  'feat': { desc: 'Features', visible: true },
  'fix': { desc: 'Bug Fixes', visible: true },
  'revert': { desc: 'Reverts', visible: true },
  'docs': { desc: 'Documentation', visible: false },
  'style': { desc: 'Styles', visible: false },
  'chore': { desc: 'Miscellaneous Chores', visible: false },
  'refactor': { desc: 'Code Refactoring', visible: false },
  'test': { desc: 'Tests', visible: false },
  'build': { desc: 'Build System', visible: false },
  'ci': { desc: 'Continuous Integration', visible: false },
}

function isConventional(commit: Commit): commit is ConventionalCommit {
  return (commit as ConventionalCommit).type !== undefined
}
const firstLineRegex: RegExp = /^(?<type>\w*)(?:\((?<scope>[\w$.\-* ]*)\))?(?<bang>\!)?: (?<desc>.*)$/
const mentionRegex: RegExp = /\#\d+/g
const BRK_CHG = 'BREAKING CHANGE'

function parse(l: DefaultLogFields): Commit {
  try {
    const { type, scope, bang, desc } = firstLineRegex.exec(l.message)!.groups!
    if (typeMap[type]) {
      const [body, ign, ...footers] = l.body.split("\n")
      return {
        type: type,
        scope: scope,
        desc: desc,
        body: body,
        footers: footers,
        isBreaking: (type == BRK_CHG)
          || bang != undefined
          || body.startsWith(BRK_CHG)
          || footers.filter(ftr => ftr.startsWith(BRK_CHG)).length > 0,
        mentions: (desc + " " + body + " " + footers.join(" "))
          .match(mentionRegex)
          ?.map(str => str.substr(1))
          .map(str => parseInt(str)) ?? []
      }
    } else {
      return {
        header: l.message,
        body: l.body
      }
    }
  } catch (error) {
    return {
      header: l.message,
      body: l.body
    }
  }
}

type ReleaseType = "minor" | "major" | "patch"
interface SemanticChangelog {
  newVersion: string
  releaseType: ReleaseType
  untrackedChanges: NonConventionalCommit[]
  breakingChanges: Map<string, ConventionalCommit[]>
  nonBreakingChanges: Map<string, ConventionalCommit[]>
}

async function getSemanticChangelog(version: string): Promise<SemanticChangelog> {
  const tagPrefix = debug ? 'v' : core.getInput('tag_prefix')
  const logs = (version == "0.0.0") ? git.log() : git
    .log({
      from: tagPrefix + version,
      to: "HEAD"
    })
  return logs
    .then(list => Array.from(list.all.values()))
    .then(list => list.map(parse))
    .then(commits => {
      const [trackedChanges, untrackedChanges] = partition(commits, isConventional)
      const [nonBreakingChangesUngrouped, breakingChangesUngrouped] = partition(trackedChanges as ConventionalCommit[], c => !c.isBreaking)
      const breakingChanges = groupBy(breakingChangesUngrouped, c => c.type)
      const nonBreakingChanges = groupBy(nonBreakingChangesUngrouped, c => c.type)
      let releaseType: ReleaseType = "patch"
      if (breakingChangesUngrouped.length > 0 && parseInt(version.split('.')[0]) > 0)
        releaseType = "major"
      else if (nonBreakingChangesUngrouped.filter(c => c.type == "feature").length > 0)
        releaseType = "minor"

      return {
        newVersion: inc(version, releaseType),
        releaseType: releaseType,
        untrackedChanges: untrackedChanges as NonConventionalCommit[],
        breakingChanges: breakingChanges,
        nonBreakingChanges: nonBreakingChanges
      }
    })
}

function inc(version: string, releaseType: ReleaseType): string {
  let [major, minor, patch] = version.split('.').map(s => parseInt(s))
  switch (releaseType) {
    case "major":
      major++
      break
    case "minor":
      minor++
      break
    case "patch":
      patch++
      break
    default:
      break
  }
  return [major, minor, patch].join('.')
}

function stringifyChg(changelog: SemanticChangelog): string {
  const date = new Date()
  const untrackedChanges = changelog.untrackedChanges.length == 0
    ? ""
    : `\n## Untracked Changes

${stringifyNonConventionalCommits(changelog.untrackedChanges)}`

  const brkChanges = changelog.breakingChanges.size == 0
    ? ""
    : `\n## Breaking Changes

${stringifyMap(changelog.breakingChanges)}`

  const changes = changelog.breakingChanges.size == 0
    ? ""
    : (brkChanges == "" && untrackedChanges == "")
      ? stringifyMap(changelog.nonBreakingChanges)
      : `\n## Changes

${stringifyMap(changelog.nonBreakingChanges)}`


  return `# ${changelog.newVersion} - ${date.getDate()}-${date.getMonth()}-${date.getFullYear()}
${untrackedChanges}${brkChanges}${changes}`
}

function stringifyNonConventionalCommits(cs: NonConventionalCommit[]) {
  return cs.map(c => `- ${stringifyHeader(c.header)}`).join("\n") + "\n"
}

function stringifyHeader(str: string): string {
  let r = str
  const prefix = debug ? 'prefix' : core.getInput('issues_url_prefix')
  str.match(mentionRegex)?.forEach(e =>
    r = r.replace(e, `[${e}](${prefix}${e})`)
  )
  return r
}

interface TypeValue {
  desc: string,
  visible: boolean
}

function stringifyMap(map: Map<string, ConventionalCommit[]>): string {
  let str = ""
  Array.from(map.entries())
    .filter(e => typeMap[e[0]]?.visible)
    .forEach(e => str += `### ${typeMap[e[0]].desc}
    
${stringifyConventionalCommits(e[1])}`)
  return str
}

function stringifyConventionalCommits(cs: ConventionalCommit[]) {
  return cs.map(c => `- ${stringifyHeader(c.desc)}`).join("\n") + "\n"
}


function groupBy<T>(arr: T[], toGroup: (val: T) => string): Map<string, T[]> {
  const m: Map<string, T[]> = new Map()
  arr.forEach(v => {
    const group = toGroup(v)
    m.set(group, (m.get(group) ?? []).concat(v))
  })
  return m
}

function partition<T>(
  arr: T[],
  predicate: (val: T) => boolean
): [T[], T[]] {
  const partitioned: [T[], T[]] = [[], []]
  arr.forEach((val: T) => {
    const partitionIndex: 0 | 1 = predicate(val) ? 0 : 1
    partitioned[partitionIndex].push(val)
  })
  return partitioned
}

run()
