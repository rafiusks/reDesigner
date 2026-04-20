/**
 * chromeMock — scripting namespace.
 * Covers: executeScript.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeScriptingMock(recorder: SideEffectRecorder) {
  return {
    executeScript(
      injection: chrome.scripting.ScriptInjection<unknown[], unknown>,
    ): Promise<chrome.scripting.InjectionResult<unknown>[]> {
      recorder.record({ type: 'scripting.executeScript', args: injection })
      return Promise.resolve([])
    },
  }
}
