/**
 * commands — chrome.commands.onCommand routing.
 *
 * 'arm-picker' calls the registered arm callback only.
 * It does NOT call chrome.sidePanel.open — keyboard gestures are not user
 * gestures per Chromium #344767733, so sidePanel.open would fail.
 */

export interface CommandsController {
  onCommand(name: string): void
  setArmPickerCallback(fn: () => void): void
}

export function createCommandsController(): CommandsController {
  let armPickerCallback: (() => void) | null = null

  function setArmPickerCallback(fn: () => void): void {
    armPickerCallback = fn
  }

  function onCommand(name: string): void {
    if (name === 'arm-picker') {
      armPickerCallback?.()
    }
    // All other commands are silently ignored.
  }

  return { onCommand, setArmPickerCallback }
}
