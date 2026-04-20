/**
 * chromeMock — commands namespace.
 * Covers: getAll, onCommand.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeCommandsMock(recorder: SideEffectRecorder) {
  const _commands: chrome.commands.Command[] = []
  const onCommandListeners: ((command: string) => void)[] = []

  return {
    getAll(): Promise<chrome.commands.Command[]> {
      recorder.record({ type: 'commands.getAll', args: null })
      return Promise.resolve([..._commands])
    },

    onCommand: {
      addListener(fn: (command: string) => void) {
        onCommandListeners.push(fn)
      },
      removeListener(fn: (command: string) => void) {
        const i = onCommandListeners.indexOf(fn)
        if (i >= 0) onCommandListeners.splice(i, 1)
      },
      hasListener(fn: (command: string) => void): boolean {
        return onCommandListeners.includes(fn)
      },
    },

    _getListeners(event: 'onCommand') {
      return onCommandListeners
    },

    emit(event: 'onCommand', command: string) {
      for (const fn of onCommandListeners) fn(command)
    },

    /** Register commands for test setup */
    _addCommand(cmd: chrome.commands.Command) {
      _commands.push(cmd)
    },
  }
}
