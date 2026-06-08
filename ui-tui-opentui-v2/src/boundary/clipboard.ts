/**
 * Clipboard (item 1) — copy via OSC 52 (works over SSH/tmux) + a native platform
 * command, and read a clipboard IMAGE for paste-to-attach. Ported/trimmed from
 * opencode `clipboard.ts`. A boundary concern (spawns processes / writes stdout);
 * everything is best-effort and never throws into the view.
 */
import { spawn } from 'node:child_process'
import { platform } from 'node:os'

/** Run a command, optionally piping `input` to stdin; resolve its stdout bytes. */
function run(cmd: string, args: string[] = [], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] })
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    const out: Buffer[] = []
    child.on('error', reject)
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exit ${code}`))))
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** OSC 52 copy — the terminal puts `text` on the system clipboard (SSH/tmux-safe). */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const seq = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`
  // tmux/screen need the sequence wrapped in their passthrough escape.
  process.stdout.write(process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq)
}

/** Native copy commands to try, in order, for the current platform. */
function copyCandidates(): Array<[string, string[]]> {
  const os = platform()
  if (os === 'darwin') return [['pbcopy', []]]
  if (os === 'win32') return [['clip', []]]
  // linux: prefer Wayland, then X11 tools
  const list: Array<[string, string[]]> = []
  if (process.env.WAYLAND_DISPLAY) list.push(['wl-copy', []])
  list.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']])
  return list
}

/** Copy `text` to the clipboard: OSC 52 (always) + the first native command that works. */
export async function writeClipboard(text: string): Promise<void> {
  writeOsc52(text)
  for (const [cmd, args] of copyCandidates()) {
    try {
      await run(cmd, args, text)
      return
    } catch {
      // try the next candidate
    }
  }
}

/** Read a clipboard IMAGE as base64 PNG (for paste-to-attach); undefined if none. */
export async function readClipboardImage(): Promise<{ data: string; mime: string } | undefined> {
  const os = platform()
  const tries: Array<[string, string[]]> = []
  if (os === 'linux') {
    if (process.env.WAYLAND_DISPLAY) tries.push(['wl-paste', ['-t', 'image/png']])
    tries.push(['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']])
  } else if (os === 'darwin') {
    tries.push(['pngpaste', ['-']]) // brew install pngpaste
  } else if (os === 'win32') {
    tries.push([
      'powershell.exe',
      [
        '-NonInteractive',
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $img=[System.Windows.Forms.Clipboard]::GetImage(); if($img){$ms=New-Object System.IO.MemoryStream; $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([System.Convert]::ToBase64String($ms.ToArray()))}'
      ]
    ])
  }
  for (const [cmd, args] of tries) {
    try {
      const buf = await run(cmd, args)
      if (buf.length) {
        // powershell already returns base64 text; the others return raw PNG bytes.
        const data = os === 'win32' ? buf.toString('utf8').trim() : buf.toString('base64')
        if (data) return { data, mime: 'image/png' }
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}
