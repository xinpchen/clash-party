import type { ChildProcess } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { managerLogger } from '../utils/logger'
import { ensureCoreProcessExited } from './process'

vi.mock('../utils/logger', () => ({
  managerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('./mihomoApi', () => ({
  getAxios: vi.fn()
}))

type FakeProc = ChildProcess & {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
}

function createFakeProc(state: {
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
}): FakeProc {
  return {
    pid: 12345,
    exitCode: state.exitCode ?? null,
    signalCode: state.signalCode ?? null,
    killed: false,
    kill: vi.fn(() => true)
  } as unknown as FakeProc
}

describe('ensureCoreProcessExited', () => {
  it('returns immediately when no process is tracked', async () => {
    const start = Date.now()
    await expect(ensureCoreProcessExited(null)).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(400)
  })

  it('returns immediately when the process has already exited', async () => {
    const proc = createFakeProc({ exitCode: 0 })
    const start = Date.now()
    await expect(ensureCoreProcessExited(proc)).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(400)
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('returns immediately when the process was terminated by a signal', async () => {
    const proc = createFakeProc({ signalCode: 'SIGINT' })
    const start = Date.now()
    await expect(ensureCoreProcessExited(proc)).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(400)
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('resolves without killing once the process exits during the grace window', async () => {
    const proc = createFakeProc({ exitCode: null })
    setTimeout(() => {
      proc.exitCode = 0
    }, 120)

    await expect(ensureCoreProcessExited(proc)).resolves.toBeUndefined()
    expect(proc.kill).not.toHaveBeenCalled()
    expect(managerLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('SIGKILL'))
  })

  it('sends SIGKILL when the process is still running after the grace window', async () => {
    const proc = createFakeProc({ exitCode: null })
    proc.kill.mockImplementation(() => {
      proc.signalCode = 'SIGKILL'
      return true
    })

    await expect(ensureCoreProcessExited(proc)).resolves.toBeUndefined()
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(managerLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not exit after SIGINT')
    )
  })

  it('throws when the process survives SIGKILL', async () => {
    const proc = createFakeProc({ exitCode: null })
    proc.kill.mockImplementation(() => true)

    await expect(ensureCoreProcessExited(proc)).rejects.toThrow(/still running after SIGKILL/)
  })
})
