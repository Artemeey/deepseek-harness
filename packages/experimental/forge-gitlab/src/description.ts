/** Merge request descriptions through the REST merge request resource. */

import type { ChangeRequestDescription, ChangeRequestRef, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { mergeRequestPath } from './urls.ts'

/** A label REST names either by its name alone or as an object carrying its color. */
const labelSchema = z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])

const descriptionSchema = z.object({
  description: z.string().nullable().optional(),
  labels: z.array(labelSchema).nullable().optional(),
  created_at: z.string(),
})

const HEX_COLOR = /^#?[0-9a-f]{6}$/i

/**
 * Read a merge request's description and labels. Uploaded images stay as they are written, since GitLab serves them
 * from the host under the reader's own session, so `images` names no alternative address.
 * @param api - REST reads of the host.
 * @param ref - merge request.
 * @param signal - cancellation of the read.
 * @returns the description, or why GitLab did not provide it.
 */
export async function readDescription(
  api: GitLabApi, ref: ChangeRequestRef, signal: AbortSignal,
): Promise<ChangeRequestDescription | ForgeFailure> {
  const read = await api.rest(ref.repository.host, `${mergeRequestPath(ref)}?with_labels_details=true`, signal)
  if (!read.ok) return read.failure
  const parsed = descriptionSchema.safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the description read' }
  return {
    body: parsed.data.description ?? '',
    labels: (parsed.data.labels ?? []).flatMap((label) => {
      if (typeof label === 'string') return [{ name: label, color: null }]
      const color = label.color ?? ''
      return [{ name: label.name, color: HEX_COLOR.test(color) ? color.replace('#', '').toLowerCase() : null }]
    }),
    // A merge request names all its labels in one answer, so a read never cuts the list.
    labelsTruncated: false,
    images: {},
    imagesExpireAt: null,
    createdAt: parsed.data.created_at,
  }
}
