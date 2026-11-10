import { createOwnerLinkSnapshotProvider } from '../../lib/corehub/core-ring-owner-link-snapshot.mjs'

export function createOwnerLinkSnapshotProviderDouble({ snapshot = null, error = null } = {}) {
  const calls = []
  const provider = createOwnerLinkSnapshotProvider(async (input) => {
    calls.push(input)
    if (error) throw error
    return snapshot
  })
  return { provider, calls }
}
