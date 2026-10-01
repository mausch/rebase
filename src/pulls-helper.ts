import * as core from '@actions/core'
import {Octokit} from '@octokit/core'
import * as OctokitTypes from '@octokit/types'
import {inspect} from 'util'

export class PullsHelper {
  private octokit: InstanceType<typeof Octokit>

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: `${token}`,
      baseUrl: process.env['GITHUB_API_URL'] || 'https://api.github.com'
    })
  }

  async get(
    repository: string,
    head: string,
    headOwner: string,
    base: string,
    includeLabels: string[],
    excludeLabels: string[],
    excludeDrafts: boolean
  ): Promise<Pull[]> {
    const [owner, repo] = repository.split('/')

    const isRebaseable = (p: Edge): boolean =>
      // Filter out pull requests where the head repo and/or branch has been deleted prematurely
      !!p.node.headRepository &&
      // Filter on head owner since the query only filters on head ref
      (headOwner.length == 0 ||
        p.node.headRepositoryOwner.login == headOwner) &&
      // Filter heads from forks where 'maintainer can modify' is false
      (p.node.headRepositoryOwner.login == owner ||
        p.node.maintainerCanModify) &&
      // Filter out pull requests with labels in the exclude list
      p.node.labels.nodes.every(function (value: Label): boolean {
        // Every label is not in the exclude list
        return !excludeLabels.includes(value.name)
      }) &&
      // Filter out drafts if set to exclude
      (!excludeDrafts || p.node.isDraft == false)

    const hasIncludedLabel = (p: Edge): boolean =>
      includeLabels.length == 0 ||
      p.node.labels.nodes.some(function (value: Label): boolean {
        // At least one label is in the include list
        return includeLabels.includes(value.name)
      })

    const filteredPulls = (await this.query(owner, repo, head, base))
      .filter(p => isRebaseable(p) && hasIncludedLabel(p))
      .map(toPull)
    core.debug(`filteredPulls: ${inspect(filteredPulls)}`)

    // A pull request stacked on a selected pull request must be rebased with
    // it, otherwise it is left behind on the base's previous commits.
    const seen = new Set(filteredPulls.map(pullKey))
    for (let i = 0; i < filteredPulls.length; i++) {
      const parent = filteredPulls[i]
      if (!isSameRepository(parent.headRepoName, repository)) continue
      const children = (await this.query(owner, repo, '', parent.headRef))
        .filter(isRebaseable)
        .map(toPull)
      for (const child of children) {
        if (seen.has(pullKey(child))) continue
        seen.add(pullKey(child))
        filteredPulls.push(child)
      }
    }

    return sortParentsFirst(filteredPulls, repository)
  }

  private async query(
    owner: string,
    repo: string,
    head: string,
    base: string
  ): Promise<Edge[]> {
    const params: OctokitTypes.RequestParameters = {
      owner: owner,
      repo: repo
    }
    if (head.length > 0) params.head = head
    if (base.length > 0) params.base = base
    const query = `query Pulls($owner: String!, $repo: String!, $head: String, $base: String) {
      repository(owner:$owner, name:$repo) {
        pullRequests(first: 100, states: OPEN, headRefName: $head, baseRefName: $base) {
          edges {
            node {
              baseRefName
              headRefName
              headRepository {
                nameWithOwner
                url
              }
              headRepositoryOwner {
                login
              }
              isDraft
              labels(first: 100) {
                nodes {
                  name
                }
              }
              maintainerCanModify
            }
          }
        }
      }
    }`
    const pulls = await this.octokit.graphql<Pulls>(query, params)
    core.debug(`Pulls: ${inspect(pulls.repository.pullRequests.edges)}`)
    return pulls.repository.pullRequests.edges
  }
}

/**
 * Orders pull requests so that each one comes after the pull request whose
 * head ref is its base ref. Otherwise keeps the given order.
 */
export function sortParentsFirst(pulls: Pull[], repository: string): Pull[] {
  const byHeadRef = new Map(
    pulls
      .filter(p => isSameRepository(p.headRepoName, repository))
      .map(p => [p.headRef, p])
  )
  const depth = (pull: Pull, visited: Set<Pull>): number => {
    const parent = byHeadRef.get(pull.baseRef)
    if (!parent || visited.has(parent)) return 0
    visited.add(parent)
    return depth(parent, visited) + 1
  }
  return pulls
    .map(pull => ({pull, depth: depth(pull, new Set([pull]))}))
    .sort((a, b) => a.depth - b.depth)
    .map(p => p.pull)
}

export function isSameRepository(a: string, b: string): boolean {
  return a.toLowerCase() == b.toLowerCase()
}

function toPull(p: Edge): Pull {
  return new Pull(
    p.node.baseRefName,
    p.node.headRepository.url,
    p.node.headRepository.nameWithOwner,
    p.node.headRefName
  )
}

function pullKey(p: Pull): string {
  return `${p.headRepoName}:${p.headRef}`
}

type Label = {
  name: string
}

type Edge = {
  node: {
    baseRefName: string
    headRefName: string
    headRepository: {
      nameWithOwner: string
      url: string
    }
    headRepositoryOwner: {
      login: string
    }
    isDraft: boolean
    labels: {
      nodes: Label[]
    }
    maintainerCanModify: boolean
  }
}

type Pulls = {
  repository: {
    pullRequests: {
      edges: Edge[]
    }
  }
}

export class Pull {
  baseRef: string
  headRepoUrl: string
  headRepoName: string
  headRef: string
  constructor(
    baseRef: string,
    headRepoUrl: string,
    headRepoName: string,
    headRef: string
  ) {
    this.baseRef = baseRef
    this.headRepoUrl = headRepoUrl
    this.headRepoName = headRepoName
    this.headRef = headRef
  }
}
