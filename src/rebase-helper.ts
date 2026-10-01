import * as core from '@actions/core'
import {GitCommandManager} from './git-command-manager'
import {Pull, isSameRepository} from './pulls-helper'
import {v4 as uuidv4} from 'uuid'

export class RebaseHelper {
  private git: GitCommandManager
  private extraOptions: string[]
  private repository: string
  private rebasedRefs = new Map<string, {from: string; to: string}>()

  constructor(git: GitCommandManager, options: string[], repository: string) {
    this.git = git
    this.extraOptions = options
    this.repository = repository
  }

  async rebase(pull: Pull): Promise<boolean> {
    core.info(
      `Attempting rebase of head ref '${pull.headRef}' at '${pull.headRepoName}'.`
    )

    // Add head remote
    const remoteName = uuidv4()
    await this.git.exec(['remote', 'add', remoteName, pull.headRepoUrl])

    // Fetch
    core.startGroup(`Fetching head ref '${pull.headRef}'.`)
    await this.git.fetch([pull.headRef], remoteName)
    core.endGroup()

    // Checkout
    core.startGroup(`Checking out head ref '${pull.headRef}'.`)
    const localRef = uuidv4()
    await this.git.checkout(
      localRef,
      `refs/remotes/${remoteName}/${pull.headRef}`
    )
    core.endGroup()

    // Get/set the committer
    core.startGroup(
      `Setting committer to match the last commit on the head ref.`
    )
    const sha = await this.git.revParse('HEAD')
    const committerName = await this.log1([`--format='%cn'`, sha])
    const committerEmail = await this.log1([`--format='%ce'`, sha])
    await this.git.config('user.name', committerName)
    await this.git.config('user.email', committerEmail)
    core.endGroup()

    // Rebase
    // origin/<base ref> still points at the base's commits from before it was
    // rebased, so replay only this pull request's own commits onto the new tip.
    const rebasedBase = this.rebasedRefs.get(pull.baseRef)
    let result: RebaseResult
    if (rebasedBase) {
      core.startGroup(
        `Rebasing on base ref '${pull.baseRef}', which was rebased from '${rebasedBase.from}' to '${rebasedBase.to}'.`
      )
      result = await this.tryRebase([
        '--onto',
        rebasedBase.to,
        rebasedBase.from
      ])
    } else {
      core.startGroup(`Rebasing on base ref '${pull.baseRef}'.`)
      result = await this.tryRebase([`origin/${pull.baseRef}`])
    }
    core.endGroup()

    if (result == RebaseResult.Rebased) {
      core.startGroup(`Pushing changes to head ref '${pull.headRef}'`)
      await this.git.push([
        '--force-with-lease',
        remoteName,
        `HEAD:${pull.headRef}`
      ])
      core.endGroup()
      if (isSameRepository(pull.headRepoName, this.repository)) {
        this.rebasedRefs.set(pull.headRef, {
          from: sha,
          to: await this.git.revParse('HEAD')
        })
      }
      core.info(`Head ref '${pull.headRef}' successfully rebased.`)
      return true
    } else if (result == RebaseResult.AlreadyUpToDate) {
      core.info(
        `Head ref '${pull.headRef}' is already up to date with the base.`
      )
    } else if (result == RebaseResult.Failed) {
      core.info(
        `Rebase of head ref '${pull.headRef}' failed. Conflicts must be resolved manually.`
      )
      // Try to abort any in-progress rebase
      await this.git.exec(['rebase', '--abort'], true)
    }

    return false
  }

  private async log1(options: string[]): Promise<string> {
    const params = ['log', '-1']
    params.push(...options)
    const output = await this.git.exec(params)
    return output.stdout.trim()
  }

  private async tryRebase(args: string[]): Promise<RebaseResult> {
    try {
      const result = await this.git.exec([
        'rebase',
        ...this.extraOptions,
        ...args
      ])
      return result ? RebaseResult.Rebased : RebaseResult.AlreadyUpToDate
    } catch {
      return RebaseResult.Failed
    }
  }
}

enum RebaseResult {
  Rebased,
  AlreadyUpToDate,
  Failed
}
