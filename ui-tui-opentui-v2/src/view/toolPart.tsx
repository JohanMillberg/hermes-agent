/**
 * ToolPart — one tool call, rendered COLLAPSED by default with a clear expand
 * affordance (spec §7; item 7 — "tools aren't collapsible and ugly-interlaced").
 *
 *   ▶ name  summary/first-line  (N lines)      ← collapsed (default), one line
 *   ▼ name                                     ← expanded header
 *   │ full output…                             ← left-bar block (capped)
 *
 * A `▶`/`▼` glyph marks expandable tools; clicking the header toggles it (mouse).
 * Running tools show `name …`; single-line/erroring tools render inline (no
 * expand). `resultText` is already `{output,exit_code}`-envelope-stripped by the
 * store. Fully themed (no hardcoded styles).
 */
import { type ToolPartState } from '../logic/store.ts'
import { useTerminalDimensions } from '@opentui/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'

import { collapseToolOutput, truncate } from '../logic/toolOutput.ts'
import { useTheme } from './theme.tsx'

const GUTTER = 2
/** Max output lines shown when expanded (a sane cap to avoid huge renders). */
const EXPANDED_MAX = 200

export function ToolPart(props: { part: ToolPartState }) {
  const theme = useTheme()
  const dims = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal(false)

  const bodyWidth = () => Math.max(20, dims().width - GUTTER - 4)
  const result = () => (props.part.resultText ?? '').replace(/\s+$/, '')
  const lines = () => (result() ? result().split('\n') : [])
  const running = () => props.part.state === 'running'
  const multiline = () => lines().length > 1
  const collapsible = () => !running() && multiline()
  // Collapsed gist: the explicit summary, else the first output line, else nothing.
  const summary = () => (props.part.error ? `✗ ${props.part.error}` : (props.part.summary || lines()[0] || ''))
  const body = createMemo(() => collapseToolOutput(result(), EXPANDED_MAX, bodyWidth() - 2))

  const headGlyph = () => (collapsible() ? (expanded() ? '▼' : '▶') : '⚡')
  const headColor = () => (props.part.error ? theme().color.error : theme().color.muted)

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, marginTop: 1 }}>
      {/* header — clickable to toggle when there's expandable output */}
      <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={() => collapsible() && setExpanded(e => !e)}>
        <box style={{ flexShrink: 0, width: GUTTER }}>
          <text selectable={false}>
            <span style={{ fg: headColor() }}>{headGlyph()}</span>
          </text>
        </box>
        <box style={{ flexDirection: 'row', flexGrow: 1, minWidth: 0 }}>
          <text>
            <span style={{ fg: theme().color.label }}>{props.part.name}</span>
            <Show when={running()}>
              <span style={{ fg: theme().color.muted }}> …</span>
            </Show>
            <Show when={!running() && summary()}>
              <span style={{ fg: props.part.error ? theme().color.error : theme().color.muted }}>
                {`  ${truncate(summary(), Math.max(1, bodyWidth() - props.part.name.length - 2))}`}
              </span>
            </Show>
            <Show when={collapsible() && !expanded()}>
              <span style={{ fg: theme().color.muted }}>{`  (${lines().length} lines)`}</span>
            </Show>
          </text>
        </box>
      </box>
      {/* expanded body — left-bar block of the (capped) output */}
      <Show when={collapsible() && expanded()}>
        <box style={{ flexDirection: 'row', flexGrow: 1, minWidth: 0, marginLeft: GUTTER }}>
          <box
            style={{
              backgroundColor: props.part.error ? theme().color.error : theme().color.border,
              flexShrink: 0,
              width: 1
            }}
          />
          <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, paddingLeft: 1 }}>
            <For each={body().lines}>
              {line => (
                <text>
                  <span style={{ fg: theme().color.muted }}>{line}</span>
                </text>
              )}
            </For>
            <Show when={body().hiddenLines > 0}>
              <text>
                <span style={{ fg: theme().color.accent }}>{`… +${body().hiddenLines} more lines`}</span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
    </box>
  )
}
