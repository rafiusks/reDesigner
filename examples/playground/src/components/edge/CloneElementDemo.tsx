import { cloneElement } from 'react'

export function CloneElementDemo() {
  const base = <div className="base">base</div>
  const cloned = cloneElement(base, { className: 'cloned' })
  return <section>{cloned}</section>
}
