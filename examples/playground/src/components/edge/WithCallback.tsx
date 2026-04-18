export function WithCallback() {
  const items = ['alpha', 'beta', 'gamma']
  return (
    <ul>
      {items.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  )
}
