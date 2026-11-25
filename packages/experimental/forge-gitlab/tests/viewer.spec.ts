import { describe, expect, it } from 'vitest'
import type { ForgeViewerQuery } from '@deepseek-ai/dsh-experimental-forge'
import { GitLabApi } from '../src/api.ts'
import type { GlabOutput } from '../src/glab.ts'
import { countViewerLists, readViewerList } from '../src/viewer.ts'
import { app, fakeGlab, HOST, json, output } from './fixtures.ts'

const signal = new AbortController().signal

/** A `glab api -i` page of merge requests, `total` in all. */
function page(total: number | null, rows: readonly unknown[]): GlabOutput {
  return output(`HTTP/1.1 200 OK\r\n${total === null ? '' : `X-Total: ${total}\r\n`}\r\n${JSON.stringify(rows)}`)
}

/** One merge request of a listing, `number` in {@link app}. */
function row(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    web_url: `https://${HOST}/group/sub/app/-/merge_requests/${number}`,
    title: `Merge request ${number}`,
    draft: false,
    sha: `${number}`.repeat(40),
    updated_at: `2026-11-2${number}T10:00:00Z`,
    author: { username: 'author', avatar_url: '/uploads/author.png', bot: false },
    reviewers: [],
    ...overrides,
  }
}

/** The username read every list starts from. */
function user(name = 'viewer'): GlabOutput {
  return json({ username: name })
}

/** A query of one list on {@link HOST}. */
function query(overrides: Partial<ForgeViewerQuery> = {}): ForgeViewerQuery {
  return { host: HOST, filter: 'authored', repository: null, limit: 50, ...overrides }
}

describe('GitLab viewer lists', () => {
  it('maps a listing into summaries', async () => {
    const glab = fakeGlab(path => path === 'user' ? user() : page(1, [row(3, { head_pipeline: { status: 'success' } })]))
    const listed = await readViewerList(new GitLabApi(glab.run), query(), signal)
    expect(listed).toEqual({
      viewer: 'viewer',
      total: 1,
      items: [{
        ref: { repository: app, number: 3 },
        url: `https://${HOST}/group/sub/app/-/merge_requests/3`,
        title: 'Merge request 3',
        draft: false,
        author: { login: 'author', avatarUrl: `https://${HOST}/uploads/author.png`, bot: false },
        headSha: '3'.repeat(40),
        checksRollup: 'success',
        reviewDecision: 'none',
        viewerReview: null,
        viewerRequest: null,
        closingIssues: [],
        closingIssuesTruncated: false,
        updatedAt: '2026-11-23T10:00:00Z',
      }],
    })
    expect(glab.calls.map(call => call.args.at(-1))).toEqual(['user', expect.stringContaining('author_username=viewer')])
  })

  it.each([
    ['a failed pipeline', { head_pipeline: { status: 'failed' } }, 'failure'],
    ['a skipped pipeline', { head_pipeline: { status: 'SKIPPED' } }, 'success'],
    ['a running pipeline', { head_pipeline: { status: 'running' } }, 'pending'],
    ['no pipeline', {}, 'none'],
    ['an empty pipeline status', { head_pipeline: { status: '' } }, 'none'],
    ['no merge request body yet', { sha: null }, 'none'],
  ])('maps %s', async (_label, overrides, expected) => {
    const glab = fakeGlab(path => path === 'user' ? user() : page(1, [row(1, overrides)]))
    const listed = await readViewerList(new GitLabApi(glab.run), query(), signal)
    expect(listed).toMatchObject({ items: [{ checksRollup: expected }] })
  })

  it('merges the involved listings, de-duplicates them, and orders them newest first', async () => {
    const glab = fakeGlab((path) => {
      if (path === 'user') return user()
      if (path.includes('author_username')) return page(2, [row(1), row(2)])
      if (path.includes('assignee_username')) return page(1, [row(2)])
      return page(1, [row(3)])
    })
    const listed = await readViewerList(new GitLabApi(glab.run), query({ filter: 'involved' }), signal)
    if ('code' in listed) throw new Error(listed.message)
    expect(listed.items.map(item => item.ref.number)).toEqual([3, 2, 1])
    expect(listed.total).toBe(4)
  })

  it('keeps the entries it can address and skips the others', async () => {
    const glab = fakeGlab(path => path === 'user' ? user() : page(2, [row(1), { title: 'no URL' }]))
    const listed = await readViewerList(new GitLabApi(glab.run), query(), signal)
    expect(listed).toMatchObject({ total: 2, items: [{ ref: { number: 1 } }] })
  })

  it('reports a repository whose entries GitLab did not list', async () => {
    const glab = fakeGlab(path => path === 'user' ? user() : output('HTTP/1.1 200 OK\r\n\r\n{"x":1}'))
    await expect(readViewerList(new GitLabApi(glab.run), query(), signal)).resolves.toEqual({
      code: 'unavailable', message: 'unexpected GitLab response to the merge request listing',
    })
  })

  it('reads the merge requests of one repository', async () => {
    const glab = fakeGlab(path => path === 'user' ? user() : page(0, []))
    await readViewerList(new GitLabApi(glab.run), query({ repository: { owner: 'group/sub', name: 'app' } }), signal)
    expect(glab.calls.at(-1)?.args.at(-1)).toBe(
      'projects/group%2Fsub%2Fapp/merge_requests?scope=all&state=opened&order_by=updated_at&sort=desc&per_page=50&author_username=viewer',
    )
  })

  it('reads the username once for several lists', async () => {
    const glab = fakeGlab(path => path === 'user' ? user() : page(0, []))
    const api = new GitLabApi(glab.run)
    await readViewerList(api, query(), signal)
    await readViewerList(api, query({ filter: 'review-requested' }), signal)
    expect(glab.calls.filter(call => call.args.at(-1) === 'user')).toHaveLength(1)
  })

  it.each([
    ['an unauthenticated user read', (path: string) => path === 'user' ? output('', 1, 'glab: 401 Unauthorized') : page(0, []), { code: 'unauthenticated', message: '401 Unauthorized' }],
    ['an unexpected user read', (path: string) => path === 'user' ? json({ login: 'viewer' }) : page(0, []), { code: 'unavailable', message: 'unexpected GitLab response to the signed-in user' }],
    ['a failed listing', (path: string) => path === 'user' ? user() : output('', 1, 'glab: (HTTP 500)'), { code: 'unavailable', message: '(HTTP 500)' }],
  ])('reports %s', async (_label, answer, failure) => {
    await expect(readViewerList(new GitLabApi(fakeGlab(answer).run), query(), signal)).resolves.toEqual(failure)
  })
})

describe('GitLab viewer counts', () => {
  it('counts every list from the totals of its listings', async () => {
    const glab = fakeGlab((path) => {
      if (path === 'user') return user()
      if (path.includes('author_username')) return page(2, [])
      if (path.includes('assignee_username')) return page(1, [])
      return page(4, [])
    })
    const counts = await countViewerLists(new GitLabApi(glab.run), HOST, signal)
    expect(counts).toEqual(new Map([['review-requested', 4], ['authored', 2], ['involved', 7]]))
    expect(glab.calls).toHaveLength(7)
  })

  it('counts a listing that names no total as empty', async () => {
    const glab = fakeGlab(path => path === 'user' ? user() : page(null, []))
    await expect(countViewerLists(new GitLabApi(glab.run), HOST, signal)).resolves.toEqual(new Map([
      ['review-requested', 0], ['authored', 0], ['involved', 0],
    ]))
  })
})
