/**
 * chromeMock — alarms namespace.
 * Covers: create, clear, clearAll, get, onAlarm.
 */

import type { SideEffectRecorder } from './recorder.js'

export function makeAlarmsMock(recorder: SideEffectRecorder) {
  const _alarms: Map<string, chrome.alarms.Alarm> = new Map()
  const onAlarmListeners: ((alarm: chrome.alarms.Alarm) => void)[] = []

  return {
    create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): Promise<void> {
      recorder.record({ type: 'alarms.create', args: { name, alarmInfo } })
      const alarm: chrome.alarms.Alarm = {
        name,
        scheduledTime: alarmInfo.when ?? Date.now() + (alarmInfo.delayInMinutes ?? 0) * 60_000,
        periodInMinutes: alarmInfo.periodInMinutes,
      }
      _alarms.set(name, alarm)
      return Promise.resolve()
    },

    clear(name?: string): Promise<boolean> {
      recorder.record({ type: 'alarms.clear', args: name ?? null })
      if (name == null) return Promise.resolve(false)
      const existed = _alarms.has(name)
      _alarms.delete(name)
      return Promise.resolve(existed)
    },

    clearAll(): Promise<boolean> {
      recorder.record({ type: 'alarms.clearAll', args: null })
      const hadAny = _alarms.size > 0
      _alarms.clear()
      return Promise.resolve(hadAny)
    },

    get(name?: string): Promise<chrome.alarms.Alarm | undefined> {
      recorder.record({ type: 'alarms.get', args: name ?? null })
      if (name == null) return Promise.resolve(undefined)
      return Promise.resolve(_alarms.get(name))
    },

    getAll(): Promise<chrome.alarms.Alarm[]> {
      recorder.record({ type: 'alarms.getAll', args: null })
      return Promise.resolve([..._alarms.values()])
    },

    onAlarm: {
      addListener(fn: (alarm: chrome.alarms.Alarm) => void) {
        if (!onAlarmListeners.includes(fn)) onAlarmListeners.push(fn)
      },
      removeListener(fn: (alarm: chrome.alarms.Alarm) => void) {
        const i = onAlarmListeners.indexOf(fn)
        if (i >= 0) onAlarmListeners.splice(i, 1)
      },
      hasListener(fn: (alarm: chrome.alarms.Alarm) => void): boolean {
        return onAlarmListeners.includes(fn)
      },
    },

    _getListeners(event: 'onAlarm') {
      return onAlarmListeners
    },

    emit(event: 'onAlarm', alarm: chrome.alarms.Alarm) {
      for (const fn of onAlarmListeners) fn(alarm)
    },
  }
}
