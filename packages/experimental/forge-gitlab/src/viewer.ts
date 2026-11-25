/**
 * Lists of the signed-in user's open merge requests through the GitLab REST API: the listing carries the fields a
 * summary needs except the review ones, and REST names a list by a username parameter, because GitLab has no `@me`
 * qualifier the way GitHub search has.
 */

import type {
  ChangeRequestSummary, ChecksRollup, ForgeFailure, ForgeRepository, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { avatarUrlOf, parseMergeRequestUrl, repositoryOf } from './urls.ts'

/** The lists this provider reads, mapped to the REST query parameters that select each one. */
const PARAMETERS: Readonly<Record<ForgeViewerFilter, readonly string[]>> = {
  'review-requested': ['reviewer_username'],
  'authored': ['author_username'],
  // GitLab has no "involves me" filter, so the three listings that approximate one are merged and de-duplicated.
  'involved': ['author_username', 'assignee_username', 'reviewer_username'],
}

/** The lists this provider offers on its hosts, in the order a reader of the review page expects them. */
export const VIEWER_FILTERS: ReadonlySet<ForgeViewerFilter> = new Set(Object.keys(PARAMETERS) as ForgeViewerFilter[])

const userSchema = z.object({ username: z.string() })

const rowSchema = z.object({
  web_url: z.string(),
  title: z.string(),
  draft: z.boolean().nullable().optional(),
  sha: z.string().nullable().optional(),
  updated_at: z.string(),
  author: z.object({ username: z.string(), avatar_url: z.string().nullable(), bot: z.boolean().optional() }).nullable().optional(),
  reviewers: z.array(z.object({ username: z.string().nullable() })).nullable().optional(),
  head_pipeline: z.object({ status: z.string() }).nullable().optional(),
})

/**
 * User names by API client and host: the counts and every list read need the name, and a status round asks for both,
 * so one REST read per host and round replaces one per list.
 */
const names = new WeakMap<GitLabApi, Map<string, string>>()

/**
 * Read the username `glab` is signed in as on one host, which every list names because GitLab has no `@me`.
 * @param api - REST reads of the host.
 * @param host - GitLab host.
 * @param signal - cancellation of the read.
 * @returns the username, or why GitLab did not provide it.
 */
async function viewerName(api: GitLabApi, host: string, signal: AbortSignal): Promise<string | ForgeFailure> {
  const known = names.get(api) ?? new Map<string, string>()
  names.set(api, known)
  const cached = known.get(host)
  if (cached !== undefined) return cached
  const read = await api.rest(host, 'user', signal)
  if (!read.ok) return read.failure
  const parsed = userSchema.safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the signed-in user' }
  known.set(host, parsed.data.username)
  return parsed.data.username
}

/**
 * Build the REST paths one list needs.
 * @param filter - the list.
 * @param username - the signed-in user.
 * @param perPage - page size, one for a count, since a count reads only the `X-Total` header.
 * @param repository - one repository to read in, or null for every repository the user can read.
 * @returns the API paths below `/api/v4/`, most recently updated first as the review page orders them.
 */
function viewerPaths(
  filter: ForgeViewerFilter, username: string, perPage: number, repository: ForgeRepository | null,
): readonly string[] {
  const scope = repository === null ? '' : `projects/${encodeURIComponent(`${repository.owner}/${repository.name}`)}/`
  const order = `scope=all&state=opened&order_by=updated_at&sort=desc&per_page=${perPage}`
  const user = encodeURIComponent(username)
  return PARAMETERS[filter].map(parameter => `${scope}merge_requests?${order}&${parameter}=${user}`)
}

/** A REST pipeline status as the combined check outcome; a listing that names no pipeline has none. */
function checksRollup(status: string | null | undefined): ChecksRollup {
  switch (status?.toUpperCase()) {
    case undefined:
    case '': return 'none'
    case 'SUCCESS':
    case 'SKIPPED': return 'success'
    case 'FAILED':
    case 'CANCELED': return 'failure'
    default: return 'pending'
  }
}

/**
 * Map one listing entry. A listing carries neither an aggregate review decision nor the signed-in user's review, and
 * names no closing issues, so the review page shows the values of a change request nobody has reviewed yet.
 * @param host - host the listing ran on.
 * @param row - the merge request fields.
 * @param viewer - the signed-in user.
 * @returns the summary, or undefined for a merge request this provider cannot address.
 */
function summaryOf(
  host: string, row: z.infer<typeof rowSchema>, viewer: string,
): ChangeRequestSummary | undefined {
  const parsed = parseMergeRequestUrl(row.web_url)
  if (parsed === undefined) return undefined
  return {
    ref: { repository: repositoryOf(parsed), number: parsed.number },
    url: row.web_url,
    title: row.title,
    draft: row.draft === true,
    author: row.author === null || row.author === undefined
      ? null
      : { login: row.author.username, avatarUrl: avatarUrlOf(host, row.author.avatar_url), bot: row.author.bot === true },
    // A merge request without a diff yet names no head commit, and the contract wants a string.
    headSha: row.sha ?? '',
    // The list entity need not carry the pipeline at all, so this reads `none` whenever GitLab omits it.
    checksRollup: checksRollup(row.head_pipeline?.status),
    reviewDecision: 'none',
    viewerReview: null,
    viewerRequest: row.reviewers?.some(reviewer => reviewer.username === viewer) === true ? { team: null } : null,
    closingIssues: [],
    closingIssuesTruncated: false,
    updatedAt: row.updated_at,
  }
}

/**
 * Read one list: GitLab names each list by a query parameter, so `involved` merges three listings and keeps one entry
 * per merge request URL.
 * @param api - REST reads of the host.
 * @param query - host, list, repository, and a limit the caller already bounded.
 * @param signal - cancellation of the read.
 * @returns the list, or why GitLab did not provide it.
 */
export async function readViewerList(
  api: GitLabApi, query: ForgeViewerQuery, signal: AbortSignal,
): Promise<ForgeViewerList | ForgeFailure> {
  const viewer = await viewerName(api, query.host, signal)
  if (typeof viewer !== 'string') return viewer
  const items = new Map<string, ChangeRequestSummary>()
  let total = 0
  for (const path of viewerPaths(query.filter, viewer, query.limit, query.repository)) {
    const read = await api.restPage(query.host, path, signal)
    if (!read.ok) return read.failure
    total += read.total ?? 0
    const rows = z.array(z.unknown()).safeParse(read.body)
    if (!rows.success) return { code: 'unavailable', message: 'unexpected GitLab response to the merge request listing' }
    for (const entry of rows.data) {
      // One entry GitLab spells differently than this listing expects costs only that entry, as GitHub's provider does.
      const row = rowSchema.safeParse(entry)
      if (!row.success) continue
      const summary = summaryOf(query.host, row.data, viewer)
      if (summary !== undefined) items.set(summary.url, summary)
    }
  }
  // The merged `involved` listings come in three orders, and the page orders one list by update time, newest first.
  const page = [...items.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, query.limit)
  // GitLab omits `X-Total` for some listings, and a page is never larger than the entries the read returned.
  return { viewer, items: page, total: Math.max(total, page.length) }
}

/**
 * Count every list on one host from the `X-Total` header of a one-entry read, which costs one request per list, since
 * GitLab counts a filtered listing only in its answer rather than through a separate count resource.
 * @param api - REST reads of the host.
 * @param host - host to count on.
 * @param signal - cancellation of the read.
 * @returns the size of each list, or why GitLab did not provide them.
 */
export async function countViewerLists(
  api: GitLabApi, host: string, signal: AbortSignal,
): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
  const viewer = await viewerName(api, host, signal)
  if (typeof viewer !== 'string') return viewer
  const counts = new Map<ForgeViewerFilter, number>()
  for (const filter of VIEWER_FILTERS) {
    let total = 0
    for (const path of viewerPaths(filter, viewer, 1, null)) {
      const read = await api.restPage(host, path, signal)
      if (!read.ok) return read.failure
      total += read.total ?? 0
    }
    counts.set(filter, total)
  }
  return counts
}
