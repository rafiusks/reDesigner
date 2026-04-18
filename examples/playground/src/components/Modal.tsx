type ModalProps = {
  open?: boolean
  children: React.ReactNode
}

export function Modal({ open = false, children }: ModalProps) {
  if (!open) return null
  return <dialog open>{children}</dialog>
}
