import Button from './components/Button'
import { DataFetcher } from './components/DataFetcher'
import { Modal } from './components/Modal'
import { PricingSection } from './components/PricingSection'
import AnonymousDefault from './components/edge/AnonymousDefault'
import { CloneElementDemo } from './components/edge/CloneElementDemo'
import { ForwardRefWrapped } from './components/edge/ForwardRefWrapped'
import { MemoWrapped } from './components/edge/MemoWrapped'
import { A, B as BExport } from './components/edge/MultiComponentFile'
import { RefAsProp } from './components/edge/RefAsProp'
import { WithCallback } from './components/edge/WithCallback'
import { WithReact19Wrappers } from './components/edge/WithReact19Wrappers'
import { WithWrappers } from './components/edge/WithWrappers'

export default function App() {
  return (
    <div className="p-4">
      <h1>redesigner playground</h1>
      <Button>one</Button>
      <PricingSection />
      <Modal open>modal-content</Modal>
      <DataFetcher>{(data) => <span>items: {data.length}</span>}</DataFetcher>
      <MemoWrapped />
      <ForwardRefWrapped placeholder="hi" />
      <RefAsProp />
      <A />
      <BExport />
      <AnonymousDefault />
      <WithCallback />
      <WithWrappers />
      <WithReact19Wrappers />
      <CloneElementDemo />
    </div>
  )
}
