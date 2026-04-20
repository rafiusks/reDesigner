/**
 * useLiveChord — reads a chrome.commands shortcut live, re-polls on
 * windows.onFocusChanged so the value stays fresh if the user changes bindings.
 *
 * Returns the shortcut string (e.g. "Ctrl+Shift+K") or null if unbound.
 * No hardcoded chord literals — callers must use this hook.
 */

import { useEffect, useState } from 'react'

export function useLiveChord(commandName: 'arm-picker' | string): string | null {
  const [chord, setChord] = useState<string | null>(null)

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.commands) return

    function poll(): void {
      chrome.commands.getAll((commands) => {
        const found = commands.find((c) => c.name === commandName)
        const shortcut = found?.shortcut ?? null
        setChord(shortcut && shortcut.length > 0 ? shortcut : null)
      })
    }

    poll()

    const handler = (): void => {
      poll()
    }

    chrome.windows.onFocusChanged.addListener(handler)

    return () => {
      chrome.windows.onFocusChanged.removeListener(handler)
    }
  }, [commandName])

  return chord
}
