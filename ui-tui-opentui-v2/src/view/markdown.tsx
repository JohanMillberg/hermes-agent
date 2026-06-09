/**
 * Markdown — assistant/reasoning text via the NATIVE `<markdown>` renderable
 * (`MarkdownRenderable`), exactly as opencode's TextPart (`routes/session/index.tsx`
 * :1687 `<markdown streaming internalBlockMode="top-level" tableOptions conceal>`).
 *
 * Why `<markdown>` (not `<code filetype="markdown">`): the anti-flicker mechanism
 * is `internalBlockMode="top-level"` — each top-level block (heading/para/list/
 * table/fence) becomes its own child renderable and `_stableBlockCount` (managed
 * internally) reports the settled head prefix, so stable blocks are NOT re-rendered
 * per streamed delta. The old `<code>` path re-measured the whole buffer each delta
 * → the content height oscillated → the scrollbar grew/shrank (the streaming
 * flicker regression). `tableOptions` renders GFM tables as an aligned grid WITH
 * inline markdown (bold/italic/code) inside cells — so a separate table renderer
 * is unnecessary. `streaming` keeps the trailing block open while chunks append and
 * finalizes it (half-open tables/fences) when flipped false.
 *
 * The `SyntaxStyle` is derived from the active theme (no hardcoded styles — §7.5)
 * and cached by theme-object identity, so all text parts share ONE instance and
 * it's rebuilt only when the skin changes (a new `Theme` object).
 */
import { RGBA, SyntaxStyle } from '@opentui/core'

import type { Theme } from '../logic/theme.ts'
import { useTheme } from './theme.tsx'

const FALLBACK = RGBA.fromHex('#E6EDF3')
const HEX6 = /^#[0-9a-fA-F]{6}$/

/** Theme colors are usually hex but may be `ansi256(n)`/`rgb(...)` after light-mode
 *  normalization — only hand hex to RGBA.fromHex, else fall back. */
function rgba(color: string): RGBA {
  return HEX6.test(color) ? RGBA.fromHex(color) : FALLBACK
}

function buildSyntaxStyle(theme: Theme): SyntaxStyle {
  const c = theme.color
  return SyntaxStyle.fromStyles({
    default: { fg: rgba(c.text) },
    'markup.heading': { bold: true, fg: rgba(c.primary) },
    'markup.heading.1': { bold: true, fg: rgba(c.primary) },
    'markup.heading.2': { bold: true, fg: rgba(c.accent) },
    'markup.heading.3': { bold: true, fg: rgba(c.accent) },
    'markup.bold': { bold: true, fg: rgba(c.text) },
    'markup.italic': { fg: rgba(c.text), italic: true },
    'markup.list': { fg: rgba(c.accent) },
    'markup.quote': { fg: rgba(c.muted) },
    'markup.link': { fg: rgba(c.accent) },
    'markup.raw': { fg: rgba(c.label) },
    'markup.raw.block': { fg: rgba(c.label) }
  })
}

let cache: { theme: Theme; style: SyntaxStyle } | undefined
function syntaxStyleFor(theme: Theme): SyntaxStyle {
  if (cache && cache.theme === theme) return cache.style
  const style = buildSyntaxStyle(theme)
  cache = { style, theme }
  return style
}

export function Markdown(props: { text: string; streaming?: boolean; fg?: string }) {
  const theme = useTheme()
  // `internalBlockMode="top-level"` is the anti-flicker mode (stable head blocks
  // aren't re-rendered per delta); `tableOptions` gives native GFM tables with
  // inline formatting; `fg` overrides the base text color (muted for reasoning).
  return (
    <markdown
      content={props.text}
      syntaxStyle={syntaxStyleFor(theme())}
      streaming={props.streaming ?? false}
      internalBlockMode="top-level"
      tableOptions={{ style: 'grid', borderColor: theme().color.border }}
      conceal
      fg={props.fg ?? theme().color.text}
    />
  )
}
