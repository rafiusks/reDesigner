type RefAsPropProps = {
  ref?: React.Ref<HTMLInputElement>
  placeholder?: string
}

export function RefAsProp({ ref, placeholder }: RefAsPropProps) {
  return <input ref={ref} placeholder={placeholder ?? 'ref-as-prop'} />
}
