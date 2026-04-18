// @ts-nocheck
import { type ReactElement, cloneElement } from 'react'

export function Wrap({ c }: { c: ReactElement }) {
  return cloneElement(c, { x: 1 })
}
