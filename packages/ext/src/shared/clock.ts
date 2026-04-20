export type Clock = () => number

let current: Clock = () => Date.now()

export function now(): number {
  return current()
}

export function setClock(c: Clock): void {
  current = c
}

export function resetClock(): void {
  current = () => Date.now()
}
