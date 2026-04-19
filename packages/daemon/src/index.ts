// Parent-facing API. Concrete startDaemon lands in Task 16.
export type DaemonHandle = {
  pid: number
  shutdown: () => Promise<void>
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: NodeJS.WritableStream
}
export async function startDaemon(_opts: { manifestPath: string }): Promise<DaemonHandle> {
  throw new Error('startDaemon not implemented yet (Task 16)')
}
