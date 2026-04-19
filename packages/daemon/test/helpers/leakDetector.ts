export function snapshotResources(): Set<string> {
  return new Set(process.getActiveResourcesInfo())
}

export function assertNoLeakedResources(before: Set<string>, after: Set<string>): void {
  const leaked: string[] = []
  const seen = new Map<string, number>()
  for (const r of before) seen.set(r, (seen.get(r) ?? 0) + 1)
  for (const r of after) {
    const c = seen.get(r) ?? 0
    if (c > 0) seen.set(r, c - 1)
    else leaked.push(r)
  }
  if (leaked.length > 0) throw new Error(`leaked resources: ${leaked.join(', ')}`)
}
