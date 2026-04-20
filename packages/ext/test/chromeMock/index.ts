/**
 * chromeMock — top-level factory.
 *
 * Composes all namespace mocks into a value assignable to `globalThis.chrome`
 * in test setup. Also exposes `_recorder` for snapshot access in fidelity tests.
 */

import { makeActionMock } from './action.js'
import { makeAlarmsMock } from './alarms.js'
import { makeCommandsMock } from './commands.js'
import { makeDebuggerMock } from './debugger.js'
import { makeIdleMock } from './idle.js'
import { makePermissionsMock } from './permissions.js'
import { makeRecorder } from './recorder.js'
import type { SideEffectRecorder } from './recorder.js'
import { makeRuntimeMock } from './runtime.js'
import { makeScriptingMock } from './scripting.js'
import { makeSidePanelMock } from './sidePanel.js'
import { makeStorageMock } from './storage.js'
import { makeTabsMock } from './tabs.js'
import { makeWindowsMock } from './windows.js'

export type { SideEffect, SideEffectRecorder } from './recorder.js'

export function makeChromeMock(clock?: () => number) {
  const recorder: SideEffectRecorder = makeRecorder(clock)

  const storage = makeStorageMock(recorder)
  const runtime = makeRuntimeMock(recorder)
  const tabs = makeTabsMock(recorder)
  const windows = makeWindowsMock(recorder)
  const action = makeActionMock(recorder)
  const alarms = makeAlarmsMock(recorder)
  const commands = makeCommandsMock(recorder)
  const sidePanel = makeSidePanelMock(recorder)
  const scripting = makeScriptingMock(recorder)
  const idle = makeIdleMock(recorder)
  const permissions = makePermissionsMock(recorder)
  const debugger_ = makeDebuggerMock(recorder)

  return {
    storage,
    runtime,
    tabs,
    windows,
    action,
    alarms,
    commands,
    sidePanel,
    scripting,
    idle,
    permissions,
    debugger: debugger_,

    /** The recorder — access snapshot() / clear() in tests. */
    _recorder: recorder,
  }
}
