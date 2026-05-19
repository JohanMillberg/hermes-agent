// StreamingMd — incremental markdown renderer for in-flight assistant text.
//
// Naive approach (render <Md text={full}/>) re-tokenizes the entire message
// on every stream delta. At 20-char batches over a 3 KB response that's 150
// full re-parses.
//
// This splits `text` at the last stable top-level block boundary (blank
// line outside a fenced code span) into:
//   stablePrefix — passed to an inner <Md>, memoized on its exact text
//                  value. During the turn, the prefix only grows monotonically,
//                  so its memo key matches the previous render and React
//                  reuses the cached subtree — zero re-tokenization.
//   unstableSuffix — the in-flight block(s). A separate <Md> re-parses just
//                    this tail on every delta (O(unstable length) vs.
//                    O(total length)).
//
// The boundary is stored in a ref so it only advances — idempotent under
// StrictMode double-render. Component unmounts between turns (isStreaming
// flips off → message moves to history and renders via <Md> directly), so
// the ref resets naturally.
//
// Layout: the two <Md> subtrees MUST render stacked (column). The parent
// container in messageLine.tsx is a default `flexDirection: 'row'` Box
// (Ink's default), so returning a bare Fragment of two <Md> siblings
// laid them out side-by-side — producing the "two jumbled columns while
// streaming" rendering bug. Wrapping in a flexDirection="column" Box
// here localizes the fix to the streaming path; the non-streaming <Md>
// already returns its own column Box, so its single-child case was never
// affected.

import { Box } from '@hermes/ink'
import { memo, useRef } from 'react'

import type { Theme } from '../theme.js'

import { Md } from './markdown.js'

// Count ``` / ~~~ AND `$$` / `\[…\]` fence toggles in `s` up to `end`. Odd
// = currently inside a fenced block; splitting the prefix there would
// orphan the fence and let the unstable suffix re-render as broken
// markdown. Math fences only toggle when the code fence is closed so
// snippets like ` ```\n$$x$$\n``` ` (math example inside a code block)
// don't double-count. A `$$x$$` line that opens AND closes on its own
// produces zero net toggles; that's `len >= 4` plus `endsDollar`.
//
// NB: this is INTENTIONALLY more conservative than `markdown.tsx`'s
// parser, which falls back to paragraph rendering when an `$$` opener
// has no matching closer. The renderer can do that safely because it
// always sees the full text on every call. The streaming chunker
// cannot — once a chunk is committed to the monotonic stable prefix it
// is frozen, so prematurely deciding "this `$$` is just prose" would
// permanently commit a paragraph rendering that becomes wrong the
// instant the closer streams in. Treating any unmatched `$$` opener
// as still-open keeps the boundary parked behind it until the closer
// arrives (or the stream ends and the non-streaming `<Md>` takes over,
// at which point the renderer's fallback kicks in correctly).
const fenceOpenAt = (s: string, end: number) => {
  let codeOpen = false
  let mathOpen = false
  let mathOpener: '$$' | '\\[' | null = null
  let i = 0

  while (i < end) {
    const nl = s.indexOf('\n', i)
    const lineEnd = nl < 0 || nl > end ? end : nl
    const line = s.slice(i, lineEnd).trim()

    if (/^(?:`{3,}|~{3,})/.test(line)) {
      codeOpen = !codeOpen
    } else if (!codeOpen) {
      if (!mathOpen && /^\$\$/.test(line)) {
        const isSingleLine = line.length >= 4 && /\$\$$/.test(line)

        if (!isSingleLine) {
          mathOpen = true
          mathOpener = '$$'
        }
      } else if (!mathOpen && /^\\\[/.test(line)) {
        const isSingleLine = /\\\]$/.test(line)

        if (!isSingleLine) {
          mathOpen = true
          mathOpener = '\\['
        }
      } else if (mathOpen && mathOpener === '$$' && /\$\$$/.test(line)) {
        mathOpen = false
        mathOpener = null
      } else if (mathOpen && mathOpener === '\\[' && /\\\]$/.test(line)) {
        mathOpen = false
        mathOpener = null
      }
    }

    if (nl < 0 || nl >= end) {
      break
    }

    i = nl + 1
  }

  return codeOpen || mathOpen
}

// Find the last "\n\n" boundary before `end` that is OUTSIDE a fenced code
// block. Returns the index AFTER the second newline (start of the next
// block), or -1 if no safe boundary exists yet.
export const findStableBoundary = (text: string) => {
  let idx = text.length

  while (idx > 0) {
    const boundary = text.lastIndexOf('\n\n', idx - 1)

    if (boundary < 0) {
      return -1
    }

    // Boundary candidate: end of stable prefix is boundary + 2 (start of
    // next block). Check fence balance up to that point.
    const splitAt = boundary + 2

    if (!fenceOpenAt(text, splitAt)) {
      return splitAt
    }

    idx = boundary
  }

  return -1
}

export const StreamingMd = memo(function StreamingMd({ cols, compact, msgId, t, text }: StreamingMdProps) {
  const stablePrefixRef = useRef('')

  // Reset if the text no longer starts with our recorded prefix (defensive;
  // normally the component unmounts between turns so this shouldn't trigger).
  if (!text.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  const boundary = findStableBoundary(text)

  // Only advance the prefix — never retreat. The boundary math looks at the
  // FULL text each call; if it returns a larger index than before, we grow
  // the cached prefix. Monotonic growth makes the memo key stable across
  // deltas (identical string → same <Md> subtree → no re-render).
  if (boundary > stablePrefixRef.current.length) {
    stablePrefixRef.current = text.slice(0, boundary)
  }

  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = text.slice(stablePrefix.length)

  // Suffix blockIndexBase is offset by SUFFIX_BLOCK_OFFSET so its blocks
  // order AFTER the prefix's in document order, regardless of how many
  // blocks the prefix has. 1_000_000 is comfortably above any realistic
  // prefix block count (would need a million top-level markdown blocks
  // in one message to collide; chat messages cap at thousands of lines).
  const SUFFIX_BLOCK_OFFSET = 1_000_000

  if (!stablePrefix) {
    return <Md cols={cols} compact={compact} msgId={msgId} t={t} text={unstableSuffix} />
  }

  if (!unstableSuffix) {
    return <Md cols={cols} compact={compact} msgId={msgId} t={t} text={stablePrefix} />
  }

  return (
    <Box flexDirection="column">
      <Md cols={cols} compact={compact} msgId={msgId} t={t} text={stablePrefix} />
      <Md blockIndexBase={SUFFIX_BLOCK_OFFSET} cols={cols} compact={compact} msgId={msgId} t={t} text={unstableSuffix} />
    </Box>
  )
})

interface StreamingMdProps {
  cols?: number
  compact?: boolean
  /** Message id this stream belongs to. Threaded into both Md subtrees so
   * the prefix and suffix blocks register under the same msgId in the
   * copy-source registry. Selection that spans both halves copies the raw
   * source seamlessly across the boundary. */
  msgId?: string
  t: Theme
  text: string
}
