import { z } from 'zod'
import { EditorSchema } from './editors.js'

/**
 * Message sent from the content script to the service worker when a
 * /__redesigner/handshake.json response has been processed.
 *
 * CS cannot know its own tabId/windowId — the service worker injects those
 * fields from `chrome.runtime.MessageSender` (sender.tab.id / sender.tab.windowId)
 * when it handles this message.
 */
export const CsRegisterMessageSchema = z
  .object({
    type: z.literal('register'),
    wsUrl: z.string().url(),
    httpUrl: z.string().url(),
    bootstrapToken: z.string().min(1),
    editor: EditorSchema,
    clientId: z.string().uuid(),
  })
  .strict()

export type CsRegisterMessage = z.infer<typeof CsRegisterMessageSchema>
