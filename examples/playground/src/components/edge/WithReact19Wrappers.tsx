import { Activity, ViewTransition } from 'react'

export function WithReact19Wrappers() {
  return (
    <Activity mode="visible">
      <ViewTransition name="fade">
        <div>react-19-wrappers</div>
      </ViewTransition>
    </Activity>
  )
}
