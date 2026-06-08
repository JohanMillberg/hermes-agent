/**
 * Header — the top chrome line (spec v4 §2 `view/header.tsx`). Phase 2 skeleton:
 * brand · engine · ready/connecting, fully themed (`useTheme()`, NO hardcoded
 * styles — §7.5). Model / cwd / context% / cost land in Phase 5b once
 * `session.info` + `Usage` are wired.
 */
import { Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { useTheme } from './theme.tsx'

export function Header(props: { store: SessionStore }) {
  const theme = useTheme()
  return (
    <box style={{ flexShrink: 0 }}>
      <text selectable={false}>
        <b>{theme().brand.name}</b>
        <span style={{ fg: theme().color.muted }}> · opentui · </span>
        <Show when={props.store.state.ready} fallback={<span style={{ fg: theme().color.muted }}>connecting…</span>}>
          <span style={{ fg: theme().color.ok }}>ready</span>
        </Show>
      </text>
    </box>
  )
}
