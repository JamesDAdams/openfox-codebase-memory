import { describe, it, expect, vi, beforeEach } from 'vitest'

type Callback = (err: Error | null, stdout?: string, stderr?: string) => void
type SpawnMock = ReturnType<typeof vi.fn> & Record<symbol, unknown>

const { execFileMock, execMock } = vi.hoisted(() => {
  const custom = Symbol.for('nodejs.util.promisify.custom')
  const execFileMock = vi.fn() as SpawnMock
  const execMock = vi.fn() as SpawnMock

  execFileMock[custom] = (file: string, args: string[], options: unknown) =>
    new Promise((resolve, reject) =>
      execFileMock(file, args, options, (err: Error | null, stdout?: string, stderr?: string) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      ),
    )

  execMock[custom] = (command: string, options: unknown) =>
    new Promise((resolve, reject) =>
      execMock(command, options, (err: Error | null, stdout?: string, stderr?: string) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      ),
    )

  return { execFileMock, execMock }
})

vi.mock('node:child_process', () => ({ execFile: execFileMock, exec: execMock }))

const { CodebaseMemoryClient } = await import('./client.js')

describe('CodebaseMemoryClient installation', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execMock.mockReset()
  })

  it('reports installed with the parsed version when the command responds to --version', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) =>
      cb(null, 'codebase-memory-mcp 0.11.0\n', ''),
    )

    const client = new CodebaseMemoryClient()
    const status = await client.checkInstallation()

    expect(status).toEqual({ installed: true, version: '0.11.0', path: 'codebase-memory-mcp' })
  })

  it('falls back to which and does not use a shell when the command is not directly executable', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) =>
      cb(new Error('not found')),
    )
    execMock.mockImplementation(() => {
      throw new Error('exec (shell) must not be used for path lookup')
    })

    const client = new CodebaseMemoryClient()
    const status = await client.checkInstallation()

    expect(status).toEqual({ installed: false })
    expect(execMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledWith(
      'which',
      ['codebase-memory-mcp'],
      { timeout: 5000 },
      expect.any(Function),
    )
  })

  it('resolves the binary path from which output', async () => {
    execFileMock.mockImplementation(
      (file: string, _args: string[], _opts: unknown, cb: Callback) => {
        if (file === 'which') return cb(null, `${process.execPath}\n`, '')
        return cb(new Error('not found'))
      },
    )

    const client = new CodebaseMemoryClient()
    const status = await client.checkInstallation()

    expect(status).toEqual({ installed: true, path: process.execPath })
  })

  it('treats a zero exit code from the installer as success', async () => {
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb: Callback) =>
      cb(null, 'installed codebase-memory-mcp 0.11.0', ''),
    )

    const client = new CodebaseMemoryClient()
    const result = await client.installCodebaseMemory()

    expect(result).toEqual({ success: true, output: 'installed codebase-memory-mcp 0.11.0' })
  })

  it('reports the installer error when the installer exits with a non-zero code', async () => {
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb: Callback) =>
      cb(new Error('curl: (22) The requested URL returned error: 404')),
    )

    const client = new CodebaseMemoryClient()
    const result = await client.installCodebaseMemory()

    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
  })
})
