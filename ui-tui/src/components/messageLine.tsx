import { Ansi, Box, NoSelect, Text } from '@hermes/ink'
import { memo, type ReactNode, useState } from 'react'

import { LONG_MSG } from '../config/limits.js'
import { sectionMode } from '../domain/details.js'
import { userDisplay } from '../domain/messages.js'
import { ROLE } from '../domain/roles.js'
import { CopySource } from '../lib/copySource/CopySource.js'
import { buildLineStartsFromRows, simpleOffsetFor } from '../lib/copySource/offsetMaps.js'
import { transcriptBodyWidth, transcriptGutterWidth } from '../lib/inputMetrics.js'
import {
  boundedLiveRenderText,
  compactPreview,
  hasAnsi,
  isPasteBackedText,
  sanitizeAnsiForRender,
  stripAnsi
} from '../lib/text.js'
import type { Theme } from '../theme.js'
import type { ActiveTool, DetailsMode, Msg, SectionVisibility } from '../types.js'

import { Md } from './markdown.js'
import { StreamingMd } from './streamingMarkdown.js'
import { ToolTrail } from './thinking.js'
import { TodoPanel } from './todoPanel.js'

// Collapse threshold for long system messages (system prompt etc.)
const SYSTEM_COLLAPSE_CHARS = 400

export const MessageLine = memo(function MessageLine({
  cols,
  compact,
  detailsMode = 'collapsed',
  detailsModeCommandOverride = false,
  isStreaming = false,
  msg,
  msgId,
  sections,
  t,
  tools = []
}: MessageLineProps) {
  // Per-section overrides win over the global mode, so resolve each section
  // we might consume here once and gate visibility on the *content-bearing*
  // sections only — never on the global mode.  A `trail` message feeds Tool
  // calls + Activity; an assistant message with thinking/tools metadata
  // feeds Thinking + Tool calls.  Gating on every section would let
  // `thinking` (expanded by default) keep an empty wrapper alive when only
  // `tools` is hidden — exactly the empty-Box bug Copilot caught.
  const thinkingMode = sectionMode('thinking', detailsMode, sections, detailsModeCommandOverride)
  const toolsMode = sectionMode('tools', detailsMode, sections, detailsModeCommandOverride)
  const activityMode = sectionMode('activity', detailsMode, sections, detailsModeCommandOverride)
  const thinking = msg.thinking?.trim() ?? ''

  // Collapse toggle for long system messages
  const systemIsLong = msg.role === 'system' && msg.text.length > SYSTEM_COLLAPSE_CHARS
  const [systemOpen, setSystemOpen] = useState(false)

  if (msg.kind === 'trail' && msg.todos?.length) {
    return (
      <TodoPanel
        defaultCollapsed={msg.todoCollapsedByDefault}
        incomplete={msg.todoIncomplete}
        t={t}
        todos={msg.todos}
      />
    )
  }

  if (msg.kind === 'trail' && (msg.tools?.length || tools.length || thinking)) {
    return thinkingMode !== 'hidden' || toolsMode !== 'hidden' || activityMode !== 'hidden' ? (
      <Box flexDirection="column">
        <ToolTrail
          commandOverride={detailsModeCommandOverride}
          detailsMode={detailsMode}
          msgId={msgId}
          reasoning={thinking}
          reasoningTokens={msg.thinkingTokens}
          sections={sections}
          t={t}
          tools={tools}
          toolTokens={msg.toolTokens}
          trail={msg.tools ?? []}
        />
      </Box>
    ) : null
  }

  if (msg.role === 'tool') {
    const maxChars = Math.max(24, cols - 14)
    const stripped = hasAnsi(msg.text) ? stripAnsi(msg.text) : msg.text
    const safeAnsi = hasAnsi(msg.text) ? sanitizeAnsiForRender(msg.text) : msg.text
    const preview = compactPreview(stripped, maxChars) || '(empty tool result)'

    const previewNode = hasAnsi(msg.text) ? (
      <Text wrap="truncate-end">
        <Ansi>{safeAnsi}</Ansi>
      </Text>
    ) : (
      <Text color={t.color.muted} wrap="truncate-end">
        {preview}
      </Text>
    )

    return (
      <Box alignSelf="flex-start" borderColor={t.color.muted} borderStyle="round" marginLeft={3} paddingX={1}>
        {wrapCopySource(msgId, msg.text, previewNode)}
      </Box>
    )
  }

  const { body, glyph, prefix } = ROLE[msg.role](t)
  const gutterWidth = transcriptGutterWidth(msg.role, t.brand.prompt)

  const showDetails =
    (toolsMode !== 'hidden' && Boolean(msg.tools?.length)) || (thinkingMode !== 'hidden' && Boolean(thinking))

  const content = (() => {
    if (msg.kind === 'slash') {
      return wrapCopySource(msgId, msg.text, <Text color={t.color.muted}>{msg.text}</Text>)
    }

    // ── Collapsible long system message (system prompt, AGENTS.md, etc.) ──
    // MUST come before the hasAnsi check — system messages from the backend
    // contain Rich markup escape codes that would otherwise hit <Ansi> full render.
    if (systemIsLong) {
      const firstLine = (msg.text.split('\n')[0] ?? '').trim().slice(0, 120) || '(system message)'

      return (
        <Box flexDirection="column">
          <Box onClick={() => setSystemOpen(v => !v)}>
            <Text color={t.color.accent}>{systemOpen ? '▾ ' : '▸ '}</Text>
            <Text color={t.color.muted}>{firstLine}</Text>
            <Text color={t.color.muted} dimColor>
              {' — '}
              {msg.text.length.toLocaleString()} chars
            </Text>
          </Box>
          {systemOpen && wrapCopySource(msgId, msg.text, <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>)}
        </Box>
      )
    }

    if (msg.role !== 'user' && hasAnsi(msg.text)) {
      return wrapCopySource(msgId, msg.text, <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>)
    }

    if (msg.role === 'assistant') {
      const bodyWidth = transcriptBodyWidth(cols, msg.role, t.brand.prompt)

      return isStreaming ? (
        // Incremental markdown: split at the last stable block boundary so
        // only the in-flight tail re-tokenizes per delta. See
        // streamingMarkdown.tsx for the cost model.
        <StreamingMd cols={bodyWidth} compact={compact} msgId={msgId} t={t} text={boundedLiveRenderText(msg.text)} />
      ) : (
        <Md cols={bodyWidth} compact={compact}
          msgId={msgId}
          t={t}
          text={msg.text}
        />
      )
    }

    if (msg.role === 'user' && msg.text.length > LONG_MSG && isPasteBackedText(msg.text)) {
      const [head, ...rest] = userDisplay(msg.text).split('[long message]')

      return wrapCopySource(
        msgId,
        msg.text,
        <Text color={body}>
          {head}
          <Text color={t.color.muted} dimColor>
            [long message]
          </Text>
          {rest.join('')}
        </Text>
      )
    }

    return wrapCopySource(msgId, msg.text, <Text {...(body ? { color: body } : {})}>{msg.text}</Text>)
  })()

  // Diff segments (emitted by pushInlineDiffSegment between narration
  // segments) need a blank line on both sides so the patch doesn't butt up
  // against the prose around it.
  const isDiffSegment = msg.kind === 'diff'

  return (
    <Box
      flexDirection="column"
      marginBottom={msg.role === 'user' || isDiffSegment ? 1 : 0}
      marginTop={msg.role === 'user' || msg.kind === 'slash' || isDiffSegment ? 1 : 0}
    >
      {showDetails && (
        <Box flexDirection="column" marginBottom={1}>
          <ToolTrail
            commandOverride={detailsModeCommandOverride}
            detailsMode={detailsMode}
            msgId={msgId}
            reasoning={thinking}
            reasoningTokens={msg.thinkingTokens}
            sections={sections}
            t={t}
            toolTokens={msg.toolTokens}
            trail={msg.tools}
          />
        </Box>
      )}

      <Box>
        <NoSelect flexShrink={0} fromLeftEdge width={gutterWidth}>
          <Text bold={msg.role === 'user'} color={prefix}>
            {glyph}{' '}
          </Text>
        </NoSelect>

        <Box width={transcriptBodyWidth(cols, msg.role, t.brand.prompt)}>{content}</Box>
      </Box>
    </Box>
  )
})

interface MessageLineProps {
  cols: number
  compact?: boolean
  detailsMode?: DetailsMode
  detailsModeCommandOverride?: boolean
  isStreaming?: boolean
  msg: Msg
  /** Stable id used to anchor copy-source ranges in the registry. When
   * unset, the message isn't covered by the copy-source pipeline — its
   * text won't survive partial-selection round-trip. Set this for any
   * message in the transcript that the user might copy. Trail / intro /
   * panel messages don't need it (no copyable body text). */
  msgId?: string
  sections?: SectionVisibility
  t: Theme
  tools?: ActiveTool[]
}

/**
 * Wrap a rendered node in a whole-message CopySource so partial selection
 * of plain (non-markdown) message content round-trips the raw source text.
 *
 * blockIndex=0 is reserved for whole-msg ranges (markdown blocks use ≥1
 * via Md's `blockIndexBase`). visualLineCount = source line count; the
 * simple offset map maps each visual row (relative to the wrapping box)
 * to the byte offset of the corresponding source line. Soft-wrap
 * continuations at the Ink layer fall past `visualLineCount`, which
 * clamps to `outerSource.length` — copying a selection that ends inside
 * a soft-wrapped continuation snaps to the end of that source line.
 *
 * When `msgId` is undefined (trail / intro / panel etc.), returns the
 * raw node — those msgs aren't covered by the copy pipeline and don't
 * need to be.
 */
function wrapCopySource(msgId: string | undefined, source: string, node: ReactNode): ReactNode {
  if (!msgId) {
    return node
  }

  const lineRows = source.split('\n')
  const rowStarts = buildLineStartsFromRows(lineRows)

  return (
    <CopySource
      blockIndex={0}
      getOffset={simpleOffsetFor(source, rowStarts)}
      msgId={msgId}
      outerSource={source}
      visualLineCount={Math.max(1, lineRows.length)}
    >
      {node}
    </CopySource>
  )
}
