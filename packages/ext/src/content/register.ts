import type { Editor } from '../shared/editors.js'
import { type CsRegisterMessage, CsRegisterMessageSchema } from '../shared/messages.js'

export interface RegisterArgs {
  wsUrl: string
  httpUrl: string
  bootstrapToken: string
  editor: Editor
}

export function buildRegisterEnvelope(args: RegisterArgs): CsRegisterMessage {
  const clientId = crypto.randomUUID()
  const envelope = {
    type: 'register' as const,
    wsUrl: args.wsUrl,
    httpUrl: args.httpUrl,
    bootstrapToken: args.bootstrapToken,
    editor: args.editor,
    clientId,
  }
  return CsRegisterMessageSchema.parse(envelope)
}
