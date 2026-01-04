import {restoreCache} from '@actions/cache'
import {getInput, setFailed, setOutput} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'
import {context} from '@actions/github'
import {diffFingerprints, Fingerprint} from '@expo/fingerprint'
import {promises} from 'fs'

const {readFile, stat} = promises

type Info = {
  currentCommit?: string
  previousCommit?: string
  currentFingerprint?: Fingerprint
  previousFingerprint?: Fingerprint
}
let info: Info = {
  currentCommit: undefined,
  previousCommit: undefined,
  currentFingerprint: undefined,
  previousFingerprint: undefined,
}

const profile = getInput('profile') as 'production' | 'preview' | 'pull-request'

const previousCommitTag = getInput('previous-commit-tag')
const currentCommit = context.sha

let mostRecentPreviewCommit: string | null = null

const run = async () => {
  // Try to restore the DB first
  const step1 = await addToIgnore()
  const step2 = step1 && (await restoreDb())
  const step3 = step2 && (await getPrevFP())
  const step4 = step3 && (await getCurrentFP())
  step4 && (await createDiff())

  return true
}

// Step 1
const addToIgnore = async () => {
  await exec('echo "most-recent-preview-commit.txt" >> .gitignore')
  return true
}

// Step 2
const restoreDb = async () => {
  const restoreRes = await restoreCache(
    ['most-recent-preview-commit.txt'],
    `most-recent-preview-commit`,
  )

  // See if the file exists
  try {
    await stat('most-recent-preview-commit.txt')
  } catch (e) {
    return true
  }

  const commit = await readFile('most-recent-preview-commit.txt', 'utf8')

  if (commit && commit.trim().length > 0) {
    mostRecentPreviewCommit = commit.trim()
  }

  return true
}

// Step 3
const getCurrentFP = async () => {
  info.currentCommit = currentCommit

  await checkoutCommit(currentCommit)
  await exec('rm -rf node_modules')
  await exec('bun install --frozen-lockfile')

  const {stdout} = await getExecOutput(`bunx @expo/fingerprint .`)

  info.currentFingerprint = JSON.parse(stdout.trim())
  return true
}

// Step 4
const getPrevFP = async () => {
  if (profile === 'pull-request') {
    const {stdout} = await getExecOutput('git rev-parse main')

    info.previousCommit = stdout.trim()
  } else if (profile === 'preview') {
    if (mostRecentPreviewCommit) {
      info.previousCommit = mostRecentPreviewCommit
    } else {
      // const {stdout: lastTag} = await getExecOutput(
      //   'git describe --tags --abbrev=0',
      // )
      const {stdout} = await getExecOutput(`git rev-parse @~`)
      info.previousCommit = stdout.trim()
    }
  } else if (profile === 'production') {
    // Fetch tags from origin to ensure they're available (GitHub Actions uses shallow clones)
    // Fetch from origin explicitly to get all tags
    await exec('git fetch origin --tags --force')

    // Try multiple tag variations: with/without v prefix, with/without refs/tags/
    const tagVariations = [
      previousCommitTag, // As provided
      previousCommitTag.startsWith('v')
        ? previousCommitTag.slice(1) // Remove v if present
        : `v${previousCommitTag}`, // Add v if not present
    ]

    let stdout: string | undefined
    let exitCode: number = 1

    for (const tag of tagVariations) {
      // Try with refs/tags/ prefix first
      const result1 = await getExecOutput(`git rev-parse refs/tags/${tag}`)
      if (result1.exitCode === 0) {
        stdout = result1.stdout
        exitCode = 0
        break
      }

      // Try without refs/tags/ prefix
      const result2 = await getExecOutput(`git rev-parse ${tag}`)
      if (result2.exitCode === 0) {
        stdout = result2.stdout
        exitCode = 0
        break
      }
    }

    if (exitCode !== 0 || !stdout) {
      setFailed(
        `Tag '${previousCommitTag}' (or 'v${previousCommitTag}') not found. Aborting.`,
      )
      return false
    }

    info.previousCommit = stdout.trim()
  }

  await checkoutCommit(info.previousCommit)
  await exec('bun install --frozen-lockfile')

  const {stdout} = await getExecOutput(`bunx @expo/fingerprint .`)

  info.previousFingerprint = JSON.parse(stdout.trim())
  return true
}

// Step 5
const createDiff = async () => {
  if (!info.currentFingerprint || !info.previousFingerprint) {
    setFailed('Fingerprints not found. Aborting.')
    return false
  }

  const diff = diffFingerprints(
    info.currentFingerprint,
    info.previousFingerprint,
  )

  const hasBareRncliAutolinking = diff.some(s =>
    s.reasons.includes('bareRncliAutolinking'),
  )
  const hasExpoAutolinkingAndroid = diff.some(s =>
    s.reasons.includes('expoAutolinkingAndroid'),
  )
  const hasExpoAutolinkingIos = diff.some(s =>
    s.reasons.includes('expoAutolinkingIos'),
  )

  const includesChanges =
    hasBareRncliAutolinking ||
    hasExpoAutolinkingAndroid ||
    hasExpoAutolinkingIos

  if (includesChanges) {
    setOutput('diff', diff)
    setOutput('includes-changes', includesChanges ? 'true' : 'false')

    if (profile === 'production') {
      setFailed('Fingerprint changes detected. Aborting.')
    }
  }
  return true
}

// -- Helpers

const checkoutCommit = async (commit: string) => {
  await exec(`git checkout ${commit}`)
}

run()
