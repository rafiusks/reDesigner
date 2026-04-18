export function List() {
  return [1, 2].map((n) => <li key={n}>{n}</li>)
}
