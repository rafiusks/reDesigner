type DataFetcherProps = {
  children: (data: number[]) => React.ReactNode
}

export function DataFetcher({ children }: DataFetcherProps) {
  const data = [1, 2, 3, 4]
  return <>{children(data)}</>
}
