export function requireFullHarness(): boolean {
  return Boolean(process.env.PW_FULL_HARNESS)
}
