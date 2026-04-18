<!-- human -->
# children-as-function

Render-prop pattern. `<DataFetcher>` opening is lexical JSX (tagged, attributed to `X`). Inside the function child, `<Row d={d} />` is lexical JSX (tagged, attributed to `X` — inner arrow is not a declarator, resolver walks up to `X`). Also `<div />` inside `Row` is tagged, attributed to `Row`. The Fragment `<>…</>` inside `DataFetcher` is skipped.
