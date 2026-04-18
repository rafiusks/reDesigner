import { forwardRef } from 'react'

type Props = { placeholder?: string }

export const ForwardRefWrapped = forwardRef<HTMLInputElement, Props>(
  function ForwardRefWrapped(props, ref) {
    return <input ref={ref} placeholder={props.placeholder ?? 'forward-ref'} />
  },
)
