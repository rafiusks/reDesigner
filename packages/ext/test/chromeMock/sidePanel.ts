/**
 * chromeMock — sidePanel namespace.
 * Covers: open, setPanelBehavior, setOptions.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeSidePanelMock(recorder: SideEffectRecorder) {
  return {
    open(options: chrome.sidePanel.OpenOptions): Promise<void> {
      recorder.record({ type: 'sidePanel.open', args: options })
      return Promise.resolve()
    },

    setPanelBehavior(behavior: chrome.sidePanel.PanelBehavior): Promise<void> {
      recorder.record({ type: 'sidePanel.setPanelBehavior', args: behavior })
      return Promise.resolve()
    },

    setOptions(options: chrome.sidePanel.PanelOptions): Promise<void> {
      recorder.record({ type: 'sidePanel.setOptions', args: options })
      return Promise.resolve()
    },
  }
}
