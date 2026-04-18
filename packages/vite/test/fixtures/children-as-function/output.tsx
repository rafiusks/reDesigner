// @ts-nocheck
type Props = {children: (d: number) => React.ReactNode;};

function DataFetcher({ children }: Props) {
  return <>{children(42)}</>;
}
type RowProps = {d: number;};
function Row(_: RowProps) {
  return <div data-redesigner-loc="src/input.tsx:9:9" />;
}

export function X() {
  return <DataFetcher data-redesigner-loc="src/input.tsx:13:9">{(d) => <Row d={d} data-redesigner-loc="src/input.tsx:13:30" />}</DataFetcher>;
}