import {Pull, sortParentsFirst} from '../lib/pulls-helper'

const repository = 'owner/repo'

function pull(baseRef: string, headRef: string, headRepoName = repository) {
  return new Pull(
    baseRef,
    `https://github.com/${headRepoName}`,
    headRepoName,
    headRef
  )
}

function headRefs(pulls: Pull[]): string[] {
  return pulls.map(p => p.headRef)
}

describe('sortParentsFirst', () => {
  it('orders a stack from its root', async () => {
    const pulls = [pull('b', 'c'), pull('a', 'b'), pull('main', 'a')]
    expect(headRefs(sortParentsFirst(pulls, repository))).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('keeps the given order of unrelated pull requests', async () => {
    const pulls = [pull('main', 'x'), pull('main', 'y'), pull('main', 'z')]
    expect(headRefs(sortParentsFirst(pulls, repository))).toEqual([
      'x',
      'y',
      'z'
    ])
  })

  it('does not treat a fork head as a parent', async () => {
    const pulls = [pull('a', 'b'), pull('main', 'a', 'fork/repo')]
    expect(headRefs(sortParentsFirst(pulls, repository))).toEqual(['b', 'a'])
  })

  it('terminates on a cycle', async () => {
    const pulls = [pull('b', 'a'), pull('a', 'b')]
    expect(sortParentsFirst(pulls, repository)).toHaveLength(2)
  })
})
