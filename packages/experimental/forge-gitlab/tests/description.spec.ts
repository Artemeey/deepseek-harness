import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import { readDescription } from '../src/description.ts'
import { fakeGlab, json, merge, mrPath, output } from './fixtures.ts'

const signal = new AbortController().signal

/** A merge request resource as the REST read names it. */
function resource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'Closes #42668',
    labels: [],
    created_at: '2026-11-24T18:18:08+03:00',
    ...overrides,
  }
}

describe('GitLab merge request description', () => {
  it('reads the description, labels, and creation time with label details', async () => {
    const glab = fakeGlab(() => json(resource({ labels: ['bug', { name: 'ui', color: '#AB12CD' }] })))
    await expect(readDescription(new GitLabApi(glab.run), merge(6), signal)).resolves.toEqual({
      body: 'Closes #42668',
      labels: [{ name: 'bug', color: null }, { name: 'ui', color: 'ab12cd' }],
      labelsTruncated: false,
      images: {},
      imagesExpireAt: null,
      createdAt: '2026-11-24T18:18:08+03:00',
    })
    expect(glab.calls.at(-1)?.args.at(-1)).toBe(`${mrPath(6)}?with_labels_details=true`)
  })

  it('reads an empty description and a label whose color GitLab did not normalize', async () => {
    const described = await readDescription(
      new GitLabApi(fakeGlab(() => json(resource({ description: null, labels: [{ name: 'ui', color: 'nope' }] }))).run), merge(6), signal,
    )
    expect(described).toMatchObject({ body: '', labels: [{ name: 'ui', color: null }] })
  })

  it.each([
    ['a missing merge request', () => output('', 1, 'glab: (HTTP 404)'), { code: 'not-found', message: '(HTTP 404)' }],
    ['an unexpected answer', () => json({ message: 'merge request' }), { code: 'unavailable', message: 'unexpected GitLab response to the description read' }],
  ])('reports %s', async (_label, answer, failure) => {
    await expect(readDescription(new GitLabApi(fakeGlab(answer).run), merge(6), signal)).resolves.toEqual(failure)
  })
})
