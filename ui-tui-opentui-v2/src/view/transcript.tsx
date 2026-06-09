/**
 * Transcript — the scrolling message pane (spec v4 §2 `view/transcript.tsx`).
 *
 * ONE full-height <scrollbox> with a reactive <For> (opencode's model — the
 * viewport clips growing output so terminal scrollback is never corrupted; no
 * `writeToScrollback`). Carries the §8 #2 gotchas EXACTLY:
 *   - `minHeight:0` on BOTH the wrapper box AND the <scrollbox> (so the flex
 *     child can shrink below content height instead of pushing the composer off),
 *   - NO `flexDirection` on the <scrollbox> ROOT style (it has internal
 *     viewport/content children; setting it there breaks content-height
 *     measurement → phantom scroll offset that clips the top + leaves a gap),
 *   - `stickyScroll` + `stickyStart="bottom"` to pin the latest line.
 *
 * A `ScrollAnchorProvider` gives collapse/expand toggles (tool/thinking) a handle
 * to hold the viewport in place so expanding doesn't yank to the bottom (#4).
 */
import type { ScrollBoxRenderable } from '@opentui/core'
import { createSignal, For, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { HomeHint } from './homeHint.tsx'
import { MessageLine } from './messageLine.tsx'
import { ScrollAnchorProvider } from './scrollAnchor.tsx'

export function Transcript(props: { store: SessionStore }) {
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable | undefined>()
  return (
    <box style={{ flexGrow: 1, minHeight: 0, marginTop: 1 }}>
      <scrollbox ref={setScroll} style={{ flexGrow: 1, minHeight: 0 }} stickyScroll stickyStart="bottom">
        <ScrollAnchorProvider scroll={scroll}>
          {/* empty-transcript home screen (item 12); replaced by messages on the first turn */}
          <Show when={props.store.state.messages.length === 0}>
            <HomeHint catalog={props.store.state.catalog} />
          </Show>
          <For each={props.store.state.messages}>{message => <MessageLine message={message} />}</For>
        </ScrollAnchorProvider>
      </scrollbox>
    </box>
  )
}
