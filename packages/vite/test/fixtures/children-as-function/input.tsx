// @ts-nocheck
type Props = { children: (d: number) => React.ReactNode }

function DataFetcher({ children }: Props) {
  return <>{children(42)}</>
}
type RowProps = { d: number }
function Row(_: RowProps) {
  return <div />
}

export function X() {
  return <DataFetcher>{(d) => <Row d={d} />}</DataFetcher>
}
