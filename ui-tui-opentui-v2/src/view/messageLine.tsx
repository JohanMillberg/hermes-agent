/**
 * MessageLine — renders one transcript row (spec v4 §2 / §7). An assistant turn
 * is ONE ordered `parts[]` dispatched by `<Switch>`/`<Match>` on `part.type`, so
 * text / reasoning / tool interleave INLINE (the §7 fix for "tools dump below").
 * User/system rows (and settled/resumed assistant rows with no parts) render flat
 * `text`. Fully themed; rich text via <b>/<span>, never an attributes bitmask (§8 #1).
 *
 * Stable `id` per part as the <For> key so a new tool part below a streaming text
 * part doesn't remount it. Native <markdown> for text parts lands in 2b-ii.
 */
import { For, Match, Show, Switch } from 'solid-js'

import type { Message } from '../logic/store.ts'
import { Markdown } from './markdown.tsx'
import { ReasoningPart } from './reasoningPart.tsx'
import { useTheme } from './theme.tsx'
import { ToolPart } from './toolPart.tsx'

const GUTTER = 2

export function MessageLine(props: { message: Message }) {
  const theme = useTheme()
  const m = () => props.message
  const glyph = () => (m().role === 'assistant' ? theme().brand.icon : m().role === 'user' ? theme().brand.prompt : '·')
  // Role-distinct color IS the hierarchy (Ink model): the human's turn is tinted
  // GOLD (label), the agent's answer is BRIGHT (text), system notes are DIM (muted).
  const glyphFg = () =>
    m().role === 'user' ? theme().color.label : m().role === 'assistant' ? theme().color.accent : theme().color.muted
  const bodyFg = () =>
    m().role === 'user' ? theme().color.label : m().role === 'system' ? theme().color.muted : theme().color.text
  const hasParts = () => (m().parts?.length ?? 0) > 0

  return (
    // One blank line above every turn so user / assistant / tool blocks read as
    // distinct turns (item: spacing). The gold-vs-bright color split does the rest.
    <box style={{ flexDirection: 'row', flexShrink: 0, marginTop: 1 }}>
      <box style={{ flexShrink: 0, width: GUTTER }}>
        {/* the role glyph is decorative — exclude it from mouse selection (item 4).
            Bold so the user `❯` / assistant `⚕` turn boundaries pop (item 8). */}
        <text selectable={false}>
          <span style={{ fg: glyphFg() }}>
            <b>{glyph()}</b>
          </span>
        </text>
      </box>
      {/* gap owns ALL inter-part spacing (item 5) — uniform 1 line between text /
          reasoning / tool regardless of order or stream timing, so blank lines
          don't pop in and out as parts are created/merged mid-stream. */}
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, gap: 1 }}>
        <Show
          when={m().role === 'assistant' && hasParts()}
          fallback={
            // No parts yet: the just-started streaming turn shows ONLY the caret,
            // inline with the glyph (not an empty line + a dangling caret below —
            // item 10 cursor misalignment); a settled row shows its flat text.
            <Show
              when={m().streaming && !hasParts()}
              fallback={
                // themed selection: a solid muted/accent bar that preserves the
                // text fg (no selectionFg → the original color shows through, so a
                // highlight over content reads as a clean bar, not SGR-inverse).
                <text selectionBg={theme().color.selectionBg}>
                  <span style={{ fg: bodyFg() }}>{m().text}</span>
                </text>
              }
            >
              <text selectable={false}>
                {/* streaming caret — a cursor glyph, not content (item 4) */}
                <span style={{ fg: theme().color.muted }}>▍</span>
              </text>
            </Show>
          }
        >
          <For each={m().parts ?? []}>
            {part => (
              <Switch>
                <Match when={part.type === 'tool' && part}>{tool => <ToolPart part={tool()} />}</Match>
                <Match when={part.type === 'reasoning' && part}>
                  {r => <ReasoningPart text={r().text} streaming={m().streaming ?? false} />}
                </Match>
                <Match when={part.type === 'text' && part}>
                  {/* ONE stable native <markdown> fed the growing text in place (no
                      per-delta remount → no scrollbar flicker, #2); it renders GFM
                      tables natively (#3). Leading/trailing blanks stripped so the
                      column `gap` is the sole inter-part spacing (item 5). */}
                  {t => <Markdown text={t().text.replace(/^\n+|\n+$/g, '')} streaming={m().streaming ?? false} />}
                </Match>
              </Switch>
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}
