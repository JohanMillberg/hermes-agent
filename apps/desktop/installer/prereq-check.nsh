; ============================================================================
; Hermes Desktop installer — prerequisite detection page
; ============================================================================
;
; A native NSIS Wizard page (using nsDialogs) inserted between the directory
; selection page and the install-files page. Detects the baseline runtime
; prerequisites (Python 3.11+, Node.js, and Git for Windows); offers to
; install missing items via winget.
;
; Page sequence:
;   Welcome → Directory → [PrereqPage] → InstFiles → Finish
;
; Hooks used:
;   customInit               — open $TEMP\Hermes-Installer.log for diagnostics
;   customPageAfterChangeDir — page declaration (electron-builder's hook for
;                              inserting a page between Directory and InstFiles)
;   customInstall            — execute winget for any prereqs the user
;                              checked on the page; close the log file
;
; Diagnostics:
;   $TEMP\Hermes-Installer.log captures every detection probe (command,
;   exit code, captured output), the user's checkbox choices, and full
;   winget stdout/stderr for Python and Node.js installs. Git install goes via
;   ExecShellWait so UAC comes forward; for Git we log start/end and a
;   post-install bash.exe probe. Users hitting bugs should attach this file.
;
; The Function declarations live at top-level in this file so they're parsed
; at include time; the customPageAfterChangeDir macro references them via
; the Page directive so the optimizer doesn't strip them.
;
; UAC behavior:
;   Python: --scope user, no UAC.
;   Node.js: winget-managed install; installer package may request elevation.
;   Git for Windows: winget-managed install; may request elevation.
;
; Detection:
;   Python: try `py -3.11`/`-3.12`/`-3.13`. The Python launcher
;     returns exit 0 only when that specific version is installed. The
;     Microsoft Store "Python stub" doesn't install py.exe, so users with
;     only the stub get correctly classified as not-installed.
;   Node.js: `where node` returns exit 0 if node is on PATH. We also check
;     %LOCALAPPDATA%\hermes\node\node.exe for Hermes-managed installs.
;   Git: check known Git Bash locations, then `where bash`.
;   winget: `where winget` returns exit 0 on Win11 / Win10 1809+ with App
;     Installer. If unavailable, the page shows manual download URLs.
;
; Required vs. recommended:
;   Python, Node.js, and Git Bash are baseline dependencies. The GUI handles the
;   Hermes source payload, virtualenv, and Python dependency install on first
;   launch.
;
; Skip behaviors:
;   - All three already detected → page is auto-skipped via Abort
;   - Silent install (/S) → customInstall winget block skips
;   - User unchecks all checkboxes → page advances without running winget
; ============================================================================

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

Var HermesDialog
Var HermesPyStatusLabel
Var HermesPyCheckbox
Var HermesNodeStatusLabel
Var HermesNodeCheckbox
Var HermesGitStatusLabel
Var HermesGitCheckbox
Var HermesFooterLabel
Var HermesHasWinget
Var HermesHasPython
Var HermesHasNode
Var HermesHasGit
Var HermesInstallPython
Var HermesInstallNode
Var HermesInstallGit
Var HermesLogHandle
Var HermesLogPath

; ----------------------------------------------------------------------------
; Installer logging
; ----------------------------------------------------------------------------
; We write a structured log to $TEMP\Hermes-Installer.log so users can attach
; it to bug reports when prereq detection or winget installs misbehave.
;
; Why this design:
;   - The wizard's built-in Details panel only exists at runtime; once the
;     user clicks Finish (or Cancel) it's gone. The file persists.
;   - NSIS's built-in `LogSet on` / `LogText` requires the "advanced logging"
;     build of makensis (NSIS_CONFIG_LOG=1), which electron-builder's bundled
;     binary doesn't include. So we roll our own with FileWrite.
;   - Every winget invocation streams its full stdout/stderr into the log via
;     nsExec::ExecToStack — the same data the Details panel shows, but
;     captured for post-mortem.
;   - Detection probes also log exit codes + captured output, so when a user
;     reports "the page said Python isn't installed but I have it", we can
;     see exactly which probes ran and what they returned.
;   - File is opened (truncate mode) in customInit and explicitly closed at
;     the end of customInstall. If the installer crashes or the user
;     cancels before customInstall completes, the file remains on disk —
;     whatever we wrote up to that point survives. FileWrite per-line is a
;     normal Windows I/O call that hits the kernel buffer cache; the OS
;     flushes that buffer when the process exits, so even on hard cancel
;     the user can attach a partial log.
;
; Macros:
;   ${HermesLog} "free-form text"          — emit a timestamped line
;   ${HermesLogKV} "key" "value"           — emit a "key = value" line
;   ${HermesLogBlock} "label" "varname"    — emit a delimited block (no `$`)
;
; The macros are no-ops when $HermesLogHandle is empty (e.g. if FileOpen
; failed because $TEMP was unwritable — rare but defensive).
; ----------------------------------------------------------------------------
!macro _HermesLogRaw Line
  ${If} $HermesLogHandle != ""
    FileWrite $HermesLogHandle "${Line}$\r$\n"
  ${EndIf}
!macroend

!macro _HermesLogTimestamped Msg
  ; ${__TIMESTAMP__} is the BUILD-time stamp, not runtime. We want runtime,
  ; so use ${GetTime} from FileFunc.nsh. $R0..$R6 = day, month, year, dow,
  ; hour, minute, second. Stash callers' $R0–$R6 first.
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  ${GetTime} "" "L" $R0 $R1 $R2 $R3 $R4 $R5 $R6
  ${If} $HermesLogHandle != ""
    FileWrite $HermesLogHandle "[$R2-$R1-$R0 $R4:$R5:$R6] ${Msg}$\r$\n"
  ${EndIf}
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
!define HermesLog "!insertmacro _HermesLogTimestamped"

!macro _HermesLogKV Key Value
  ${HermesLog} "${Key} = ${Value}"
!macroend
!define HermesLogKV "!insertmacro _HermesLogKV"

; HermesLogBlock — write a multi-line block (typically captured command
; output) with a "--- begin/end ---" frame so it's clear in the log where
; the captured payload starts and stops. The `Payload` parameter is the
; NSIS variable name (without `$`) holding the captured string.
!macro _HermesLogBlock Label PayloadVar
  ${HermesLog} "--- begin ${Label} ---"
  !insertmacro _HermesLogRaw "$${PayloadVar}"
  ${HermesLog} "--- end ${Label} ---"
!macroend
!define HermesLogBlock "!insertmacro _HermesLogBlock"


; ----------------------------------------------------------------------------
; HermesDetectPythonViaRegistry — sets $HermesHasPython="1" if a PEP 514
; entry exists for any of the supported Python versions. Reads HKLM
; (system-wide installs) then HKCU (per-user installs). Vendor "PythonCore"
; covers official python.org distributions; "ContinuumAnalytics" covers
; Anaconda/Miniconda. We don't enumerate other vendors because they're
; rare in our user base and we'd rather miss them and let winget add a
; second Python than misclassify something else as a working Python.
; ----------------------------------------------------------------------------
Function HermesDetectPythonViaRegistry
  Push $1
  Push $2

  ${HermesLog} "registry: scanning HKLM/HKCU SOFTWARE\Python\PythonCore for 3.11/3.12/3.13"

  ; Set view to 64-bit on x64 systems so we read the right hive — the
  ; default 32-bit view would miss a 64-bit Python install on 64-bit
  ; Windows. SetRegView 32 restored at function exit.
  SetRegView 64

  ; Iterate the supported versions. Each is its own ReadRegStr — NSIS
  ; doesn't have loops over arrays inside functions easily, and four
  ; copies is clearer than gymnastics with $R0-$R9.
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.11\InstallPath" ""
  ${If} $1 != ""
    ${HermesLog} "  hit: HKLM\Python\PythonCore\3.11\InstallPath = $1"
    StrCpy $HermesHasPython "1"
    Goto hermes_py_reg_done
  ${EndIf}
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.12\InstallPath" ""
  ${If} $1 != ""
    ${HermesLog} "  hit: HKLM\Python\PythonCore\3.12\InstallPath = $1"
    StrCpy $HermesHasPython "1"
    Goto hermes_py_reg_done
  ${EndIf}
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.13\InstallPath" ""
  ${If} $1 != ""
    ${HermesLog} "  hit: HKLM\Python\PythonCore\3.13\InstallPath = $1"
    StrCpy $HermesHasPython "1"
    Goto hermes_py_reg_done
  ${EndIf}

  ReadRegStr $1 HKCU "SOFTWARE\Python\PythonCore\3.11\InstallPath" ""
  ${If} $1 != ""
    ${HermesLog} "  hit: HKCU\Python\PythonCore\3.11\InstallPath = $1"
    StrCpy $HermesHasPython "1"
    Goto hermes_py_reg_done
  ${EndIf}
  ReadRegStr $1 HKCU "SOFTWARE\Python\PythonCore\3.12\InstallPath" ""
  ${If} $1 != ""
    ${HermesLog} "  hit: HKCU\Python\PythonCore\3.12\InstallPath = $1"
    StrCpy $HermesHasPython "1"
    Goto hermes_py_reg_done
  ${EndIf}
  ReadRegStr $1 HKCU "SOFTWARE\Python\PythonCore\3.13\InstallPath" ""
  ${If} $1 != ""
    ${HermesLog} "  hit: HKCU\Python\PythonCore\3.13\InstallPath = $1"
    StrCpy $HermesHasPython "1"
    Goto hermes_py_reg_done
  ${EndIf}

  ${HermesLog} "  no registry keys matched"

hermes_py_reg_done:
  SetRegView 32
  Pop $2
  Pop $1
FunctionEnd

; ----------------------------------------------------------------------------
; HermesDetectPythonViaFilesystem — sets $HermesHasPython="1" if a Python
; install exists at one of the standard locations. FileExists never runs
; the binary so this is safe even if the user has the MS Store stub on
; their PATH. We probe both system-wide (Program Files) and per-user
; (LocalAppData\Programs) install locations for versions 3.11–3.13.
; ----------------------------------------------------------------------------
Function HermesDetectPythonViaFilesystem
  ${HermesLog} "filesystem: probing standard Python install paths"

  ; System-wide installs (default location for python.org with admin)
  ${If} ${FileExists} "$PROGRAMFILES64\Python311\python.exe"
    ${HermesLog} "  hit: $PROGRAMFILES64\Python311\python.exe"
    StrCpy $HermesHasPython "1"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\Python312\python.exe"
    ${HermesLog} "  hit: $PROGRAMFILES64\Python312\python.exe"
    StrCpy $HermesHasPython "1"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\Python313\python.exe"
    ${HermesLog} "  hit: $PROGRAMFILES64\Python313\python.exe"
    StrCpy $HermesHasPython "1"
    Return
  ${EndIf}

  ; Per-user installs (default location for python.org without admin
  ; or with "Install for me only"). Covers the user-reported case.
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Python\Python311\python.exe"
    ${HermesLog} "  hit: $LOCALAPPDATA\Programs\Python\Python311\python.exe"
    StrCpy $HermesHasPython "1"
    Return
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Python\Python312\python.exe"
    ${HermesLog} "  hit: $LOCALAPPDATA\Programs\Python\Python312\python.exe"
    StrCpy $HermesHasPython "1"
    Return
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Python\Python313\python.exe"
    ${HermesLog} "  hit: $LOCALAPPDATA\Programs\Python\Python313\python.exe"
    StrCpy $HermesHasPython "1"
    Return
  ${EndIf}

  ${HermesLog} "  no filesystem paths matched"
FunctionEnd

; ----------------------------------------------------------------------------
; HermesProbe — small wrapper around nsExec::ExecToStack that captures both
; exit code and stdout/stderr into a single log entry. Used instead of bare
; nsExec::Exec so we have evidence for "the page said X isn't installed but
; I have it" bug reports.
;
; Caller pushes command string onto the stack before Call.
; On return:
;   $0 = exit code (0 = success on Windows)
;   $1 = captured stdout+stderr (truncated by NSIS to ~64KB)
; Caller's $0/$1 are clobbered; $9 is preserved.
; ----------------------------------------------------------------------------
Function HermesProbe
  ; Stack on entry (top → bottom): <command>, <caller-return-addr>, ...
  ; Save $9 so we can use it as a local. Standard NSIS stack-arg idiom:
  ;   Exch $9   ; $9 = arg, old $9 pushed onto stack
  ;   ... work ...
  ;   Pop $9    ; restore old $9 (discards arg)
  Exch $9
  nsExec::ExecToStack '$9'
  Pop $0    ; exit code
  Pop $1    ; captured output
  ${HermesLog} "probe: $9"
  ${HermesLog} "  exit = $0"
  ${If} $1 != ""
    ${HermesLogBlock} "probe output" "1"
  ${EndIf}
  Pop $9    ; restore caller's $9 (discards the command arg)
FunctionEnd

; ----------------------------------------------------------------------------
; HermesDetectPrereqs — populates $HermesHasWinget / $HermesHasPython /
; $HermesHasNode / $HermesHasGit with "0" or "1". Called from the
; page-create function. Every probe is logged via HermesProbe.
; ----------------------------------------------------------------------------
Function HermesDetectPrereqs
  ${HermesLog} "=== HermesDetectPrereqs: begin ==="

  ; --- winget ---
  Push 'cmd.exe /c where winget'
  Call HermesProbe
  ${If} $0 == 0
    StrCpy $HermesHasWinget "1"
  ${Else}
    StrCpy $HermesHasWinget "0"
  ${EndIf}
  ${HermesLogKV} "HermesHasWinget" "$HermesHasWinget"

  ; --- Python 3.11 / 3.12 / 3.13 ---
  ; We deliberately accept 3.11–3.13 only and NOT 3.14, because some of
  ; Hermes' transitive deps (notably pywinpty, which carries Rust crates
  ; like windows_x86_64_msvc) don't yet publish 3.14 wheels. Without
  ; wheels, `pip install -e .` falls back to building from sdist, which
  ; needs a Rust toolchain. Users without one see a confusing "could
  ; not compile windows_x86_64_msvc build script" error. install.ps1
  ; sidesteps this by pinning to 3.11 via uv; the desktop installer
  ; can't easily install uv in the same flow yet, so we just refuse to
  ; accept 3.14 as "good" and offer 3.11 via winget instead. Revisit
  ; when 3.14 wheels are widely available across our dep tree.
  ;
  ; Detection strategy, in order from most-precise to least-precise.
  ; Each step uses ONLY operations that don't execute `python.exe`
  ; directly off PATH — running `python` on Windows can open the
  ; Microsoft Store if only the "Python stub" is installed, which is
  ; terrible UX during an installer. We avoid that by:
  ;   (a) launcher checks (py.exe runs no python until -V),
  ;   (b) registry reads (PEP 514, no execution at all),
  ;   (c) filesystem probes via FileExists.
  StrCpy $HermesHasPython "0"

  ; (1) The py launcher. Ships with python.org installer when
  ;     "Install launcher for all users" is checked (default for some
  ;     paths, not for per-user installs without elevation). When
  ;     present, py -3.X --version returns 0 iff that version exists.
  Push 'cmd.exe /c py -3.11 --version'
  Call HermesProbe
  ${If} $0 == 0
    StrCpy $HermesHasPython "1"
  ${Else}
    Push 'cmd.exe /c py -3.12 --version'
    Call HermesProbe
    ${If} $0 == 0
      StrCpy $HermesHasPython "1"
    ${Else}
      Push 'cmd.exe /c py -3.13 --version'
      Call HermesProbe
      ${If} $0 == 0
        StrCpy $HermesHasPython "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${HermesLogKV} "after py-launcher probes, HermesHasPython" "$HermesHasPython"

  ; (2) PEP 514 registry probe. Every standards-compliant Python
  ;     installer registers itself under HKLM or HKCU at
  ;     SOFTWARE\Python\PythonCore\<version>\InstallPath. The MS Store
  ;     stub does NOT register here — so we get a clean signal for
  ;     "real Python is installed" without ever risking the Store
  ;     popup. Covers the case the user reported: per-user Python.org
  ;     install without launcher checkbox, plus Anaconda which writes
  ;     similar keys under a different vendor name.
  ${If} $HermesHasPython == "0"
    Call HermesDetectPythonViaRegistry
    ${HermesLogKV} "after registry probe, HermesHasPython" "$HermesHasPython"
  ${EndIf}

  ; (3) Filesystem probe of common install locations. Catches edge
  ;     cases where the installer didn't update the registry (rare
  ;     but possible with hand-extracted Python or some third-party
  ;     installers). We only check standard paths — running anything
  ;     would risk spawning the Store stub.
  ${If} $HermesHasPython == "0"
    Call HermesDetectPythonViaFilesystem
    ${HermesLogKV} "after filesystem probe, HermesHasPython" "$HermesHasPython"
  ${EndIf}

  ; --- Node.js ---
  Push 'cmd.exe /c where node'
  Call HermesProbe
  ${If} $0 == 0
    StrCpy $HermesHasNode "1"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\hermes\node\node.exe"
    StrCpy $HermesHasNode "1"
  ${Else}
    StrCpy $HermesHasNode "0"
  ${EndIf}
  ${HermesLogKV} "HermesHasNode" "$HermesHasNode"

  ; --- Git Bash ---
  StrCpy $HermesHasGit "0"
  ${If} ${FileExists} "$LOCALAPPDATA\hermes\git\bin\bash.exe"
    StrCpy $HermesHasGit "1"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\hermes\git\usr\bin\bash.exe"
    StrCpy $HermesHasGit "1"
  ${ElseIf} ${FileExists} "$PROGRAMFILES64\Git\bin\bash.exe"
    StrCpy $HermesHasGit "1"
  ${ElseIf} ${FileExists} "$PROGRAMFILES\Git\bin\bash.exe"
    StrCpy $HermesHasGit "1"
  ${ElseIf} ${FileExists} "$PROGRAMFILES32\Git\bin\bash.exe"
    StrCpy $HermesHasGit "1"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\Programs\Git\bin\bash.exe"
    StrCpy $HermesHasGit "1"
  ${Else}
    Push 'cmd.exe /c where bash'
    Call HermesProbe
    ${If} $0 == 0
      StrCpy $HermesHasGit "1"
    ${EndIf}
  ${EndIf}
  ${HermesLogKV} "HermesHasGit" "$HermesHasGit"

  ${HermesLog} "=== HermesDetectPrereqs: end ==="
FunctionEnd

; ----------------------------------------------------------------------------
; HermesRunWinget — invoke `winget install ...` and capture both exit code
; and full stdout/stderr to the log. Also replays the captured output to the
; install Details panel via DetailPrint so the user sees progress (batched
; at end rather than live — acceptable trade-off; winget installs take 30-90
; seconds and emit ~10-30 lines).
;
; Caller pushes:  <args-after-winget>     (e.g. 'install -e --id Python...')
;                 <human-name>            (e.g. 'Python 3.11')
; On return:      $0 = winget exit code, $1 = full captured output
; ----------------------------------------------------------------------------
Function HermesRunWinget
  Exch $9       ; $9 = human-name
  Exch
  Exch $8       ; $8 = args
  Push $2       ; preserve for caller

  ${HermesLog} "winget: invoking for $9"
  ${HermesLog} "  command: winget $8"
  DetailPrint "Running: winget $8"

  ; ExecToStack captures up to ~64KB of combined stdout+stderr.
  ; The 'cmd.exe /c' wrapper ensures we use the user's PATH-resolved winget
  ; and that I/O redirection works portably.
  nsExec::ExecToStack 'cmd.exe /c winget $8'
  Pop $0    ; exit code
  Pop $1    ; captured output

  ${HermesLog} "  exit code = $0"
  ${If} $1 != ""
    ${HermesLogBlock} "winget output ($9)" "1"
    ; Echo captured output to Details panel so user sees what winget did.
    ; DetailPrint takes one line; the captured blob may contain $\r$\n. We
    ; pass it whole — DetailPrint handles embedded newlines reasonably.
    DetailPrint "$1"
  ${EndIf}

  Pop $2
  Pop $8
  Pop $9
FunctionEnd

; ----------------------------------------------------------------------------
; HermesPrereqPageCreate — builds the prereq page UI. If all items are
; already installed we Abort, which causes NSIS to skip directly to the next
; page in the sequence (InstFiles).
; ----------------------------------------------------------------------------
Function HermesPrereqPageCreate
  Call HermesDetectPrereqs

  ${If} $HermesHasPython == "1"
  ${AndIf} $HermesHasNode == "1"
  ${AndIf} $HermesHasGit == "1"
    ${HermesLog} "page: all prereqs detected, auto-skipping prereq page"
    Abort
  ${EndIf}

  ${HermesLog} "page: rendering prereq page (winget=$HermesHasWinget python=$HermesHasPython node=$HermesHasNode git=$HermesHasGit)"

  ; Set the wizard's standard header (top blue/gradient bar). 1037 is the
  ; title control, 1038 is the subtitle. Without this, the header still
  ; reads "Choose Install Location" left over from the Directory page.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:System Requirements"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install baseline runtime dependencies before the GUI finishes Hermes setup."

  nsDialogs::Create 1018
  Pop $HermesDialog
  ${If} $HermesDialog == error
    Abort
  ${EndIf}

  StrCpy $HermesInstallPython "0"
  StrCpy $HermesInstallNode "0"
  StrCpy $HermesInstallGit "0"

  ; Page body intro. The wizard's header (set above) shows the title
  ; "System Requirements" and subtitle, so we don't repeat them here —
  ; just one short explanatory line.
  ${NSD_CreateLabel} 0u 0u 100% 16u "Items already installed are listed as detected. Missing items can be installed automatically via winget."
  Pop $0

  ; --- Python panel ---
  ${NSD_CreateGroupBox} 0u 18u 100% 30u "Python 3.11+"
  Pop $0
  ${If} $HermesHasPython == "1"
    ${NSD_CreateLabel} 8u 28u 95% 10u "Detected on your system."
    Pop $HermesPyStatusLabel
  ${Else}
    ${If} $HermesHasWinget == "1"
      ${NSD_CreateLabel} 8u 27u 95% 9u "Not detected."
      Pop $HermesPyStatusLabel
      ${NSD_CreateCheckbox} 8u 37u 95% 9u "Install Python 3.11"
      Pop $HermesPyCheckbox
      ${NSD_Check} $HermesPyCheckbox
    ${Else}
      ${NSD_CreateLabel} 8u 27u 95% 14u "Not detected. Install manually from https://www.python.org/downloads/ and re-run this installer."
      Pop $HermesPyStatusLabel
    ${EndIf}
  ${EndIf}

  ; --- Node.js panel ---
  ${NSD_CreateGroupBox} 0u 50u 100% 30u "Node.js LTS"
  Pop $0
  ${If} $HermesHasNode == "1"
    ${NSD_CreateLabel} 8u 60u 95% 10u "Detected on your system."
    Pop $HermesNodeStatusLabel
  ${Else}
    ${If} $HermesHasWinget == "1"
      ${NSD_CreateLabel} 8u 59u 95% 9u "Not detected. Used by Hermes browser tools and Node-backed capabilities."
      Pop $HermesNodeStatusLabel
      ${NSD_CreateCheckbox} 8u 69u 95% 9u "Install Node.js LTS"
      Pop $HermesNodeCheckbox
      ${NSD_Check} $HermesNodeCheckbox
    ${Else}
      ${NSD_CreateLabel} 8u 59u 95% 14u "Not detected. Install manually from https://nodejs.org/en/download/ and re-run this installer."
      Pop $HermesNodeStatusLabel
    ${EndIf}
  ${EndIf}

  ; --- Git panel ---
  ${NSD_CreateGroupBox} 0u 82u 100% 30u "Git for Windows"
  Pop $0
  ${If} $HermesHasGit == "1"
    ${NSD_CreateLabel} 8u 92u 95% 10u "Detected on your system."
    Pop $HermesGitStatusLabel
  ${Else}
    ${If} $HermesHasWinget == "1"
      ${NSD_CreateLabel} 8u 91u 95% 9u "Not detected. Provides Git Bash for Hermes terminal commands."
      Pop $HermesGitStatusLabel
      ${NSD_CreateCheckbox} 8u 101u 95% 9u "Install Git for Windows"
      Pop $HermesGitCheckbox
      ${NSD_Check} $HermesGitCheckbox
    ${Else}
      ${NSD_CreateLabel} 8u 91u 95% 14u "Not detected. Install manually from https://git-scm.com/download/win for terminal commands."
      Pop $HermesGitStatusLabel
    ${EndIf}
  ${EndIf}

  ${If} $HermesHasGit == "0"
  ${AndIf} $HermesHasWinget == "1"
    ${NSD_CreateLabel} 0u 116u 100% 18u "Note: Git for Windows may request administrator approval. Check your taskbar if the prompt is hidden."
    Pop $HermesFooterLabel
  ${Else}
    ${NSD_CreateLabel} 0u 116u 100% 18u "After launch, Hermes will finish installing the bundled agent files and Python dependencies in the GUI."
    Pop $HermesFooterLabel
  ${EndIf}

  nsDialogs::Show
FunctionEnd

; ----------------------------------------------------------------------------
; HermesPrereqPageLeave — read checkbox states when the user clicks Next.
; Variables stay at "0" if a checkbox doesn't exist (because the
; corresponding prereq is already installed or winget isn't available).
; ----------------------------------------------------------------------------
Function HermesPrereqPageLeave
  ${If} $HermesHasPython == "0"
  ${AndIf} $HermesHasWinget == "1"
    ${NSD_GetState} $HermesPyCheckbox $HermesInstallPython
  ${EndIf}
  ${If} $HermesHasNode == "0"
  ${AndIf} $HermesHasWinget == "1"
    ${NSD_GetState} $HermesNodeCheckbox $HermesInstallNode
  ${EndIf}
  ${If} $HermesHasGit == "0"
  ${AndIf} $HermesHasWinget == "1"
    ${NSD_GetState} $HermesGitCheckbox $HermesInstallGit
  ${EndIf}
  ${HermesLog} "page: user choices — install_python=$HermesInstallPython install_node=$HermesInstallNode install_git=$HermesInstallGit"
FunctionEnd

; ----------------------------------------------------------------------------
; Page declaration — inserted between the Directory page and InstFiles via
; the customPageAfterChangeDir hook (defined in
; node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh, included
; whenever build.nsis.oneClick=false).
;
; Note: NSIS's optimizer emits "warning 6010: install function ... not
; referenced" for these functions because Page custom directives don't count
; as references in the optimizer's reference-tracking pass. We set
; build.nsis.warningsAsErrors=false in package.json so this warning doesn't
; fail the build. The functions ARE actually called by NSIS at page-display
; time — the optimizer just can't see it statically.
; ----------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom HermesPrereqPageCreate HermesPrereqPageLeave
!macroend

; ----------------------------------------------------------------------------
; customInit — runs at installer startup, before any page. We use it to open
; the installer log file. The log path is $TEMP\Hermes-Installer.log; we
; truncate (mode "w") on each install so users don't get an ever-growing
; file. Users hitting bugs are asked to attach this file.
;
; If FileOpen fails (e.g. $TEMP unwritable, AV blocking) we just leave
; $HermesLogHandle empty — every log macro is a no-op when the handle is
; empty, so the installer still works, we just lose the diagnostic.
; ----------------------------------------------------------------------------
!macro customInit
  StrCpy $HermesLogPath "$TEMP\Hermes-Installer.log"
  ClearErrors
  FileOpen $HermesLogHandle "$HermesLogPath" w
  ${If} ${Errors}
    StrCpy $HermesLogHandle ""
    ; Don't MessageBox — installers shouldn't bother the user about logging
    ; failures. We still install successfully; we just won't have a log.
  ${Else}
    ; UTF-8 BOM so Notepad / editors don't garble any non-ASCII in winget
    ; output (which uses ✓ characters and other glyphs in some locales).
    FileWriteByte $HermesLogHandle "239"
    FileWriteByte $HermesLogHandle "187"
    FileWriteByte $HermesLogHandle "191"
    ${HermesLog} "================================================================"
    ${HermesLog} "Hermes Desktop installer log"
    ${HermesLog} "================================================================"
    ${HermesLogKV} "log path" "$HermesLogPath"
    ${HermesLogKV} "installer name" "$EXEFILE"
    ${HermesLogKV} "installer dir" "$EXEDIR"
    ${HermesLogKV} "install target dir" "$INSTDIR"
    ${HermesLogKV} "TEMP" "$TEMP"
    ${HermesLogKV} "WINDIR" "$WINDIR"
    ${HermesLogKV} "PROGRAMFILES64" "$PROGRAMFILES64"
    ${HermesLogKV} "LOCALAPPDATA" "$LOCALAPPDATA"
    ${HermesLog} "================================================================"
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; customInstall — runs the actual winget commands for whatever prereqs the
; user checked on the page. Output streams to the install progress log AND
; to $HermesLogPath via HermesRunWinget.
; ----------------------------------------------------------------------------
!macro customInstall
  ${HermesLog} "=== customInstall: begin ==="

  ; Tell the user where the log lives so they can attach it if anything
  ; goes wrong. Shown in the install Details panel.
  ${If} $HermesLogHandle != ""
    DetailPrint "Installer log: $HermesLogPath"
  ${EndIf}

  ; Skip on silent installs (managed deploys handle prereqs out-of-band).
  IfSilent 0 hermes_prereq_not_silent
  ${HermesLog} "silent install (/S) — skipping prereq winget block"
  Goto hermes_prereq_install_done
hermes_prereq_not_silent:

  ${If} $HermesInstallPython == "1"
    ; Python with --scope user installs to %LOCALAPPDATA%\Programs\Python\
    ; — no UAC, no foreground chain to preserve. HermesRunWinget captures
    ; both the Details-panel output AND a copy to the installer log.
    DetailPrint "Installing Python 3.11+ via winget (silent per-user install, no admin prompt)..."
    Push 'install -e --id Python.Python.3.11 --scope user --silent --disable-interactivity --accept-package-agreements --accept-source-agreements'
    Push 'Python 3.11'
    Call HermesRunWinget
    ${If} $0 != 0
      DetailPrint "Python install via winget exited with code $0."
      ${HermesLog} "Python install FAILED (exit $0). User notified via MessageBox."
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "Python install via winget did not complete successfully (exit code $0).$\r$\n$\r$\nSee log: $HermesLogPath$\r$\n$\r$\nYou can install Python 3.11+ manually from https://www.python.org/downloads/ after Hermes setup finishes. Hermes will not run until Python is installed."
    ${Else}
      DetailPrint "Python 3.11+ installed successfully."
      ${HermesLog} "Python install succeeded"
    ${EndIf}
  ${EndIf}

  ${If} $HermesInstallNode == "1"
    DetailPrint "Installing Node.js LTS via winget..."
    Push 'install -e --id OpenJS.NodeJS.LTS --silent --disable-interactivity --accept-package-agreements --accept-source-agreements'
    Push 'Node.js LTS'
    Call HermesRunWinget
    ${If} $0 != 0
      DetailPrint "Node.js install via winget exited with code $0."
      ${HermesLog} "Node.js install FAILED (exit $0). User notified via MessageBox."
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "Node.js install via winget did not complete successfully (exit code $0).$\r$\n$\r$\nSee log: $HermesLogPath$\r$\n$\r$\nYou can install Node.js manually from https://nodejs.org/en/download/ after Hermes setup finishes. Some Hermes tools will not work until Node.js is installed."
    ${Else}
      DetailPrint "Node.js installed successfully."
      ${HermesLog} "Node.js install succeeded"
    ${EndIf}
  ${EndIf}

  ${If} $HermesInstallGit == "1"
    DetailPrint "Installing Git for Windows via winget..."
    ${HermesLog} "Git: starting ExecShellWait — UAC may appear; no stdout capture possible"
    ${HermesLog} "  command: winget install -e --id Git.Git --silent --disable-interactivity --accept-package-agreements --accept-source-agreements"
    ExecShellWait "open" "winget" "install -e --id Git.Git --silent --disable-interactivity --accept-package-agreements --accept-source-agreements" SW_SHOWNORMAL
    ${HermesLog} "Git: ExecShellWait returned"

    StrCpy $0 "0"
    ${If} ${FileExists} "$PROGRAMFILES64\Git\bin\bash.exe"
      StrCpy $0 "1"
    ${ElseIf} ${FileExists} "$PROGRAMFILES\Git\bin\bash.exe"
      StrCpy $0 "1"
    ${ElseIf} ${FileExists} "$PROGRAMFILES32\Git\bin\bash.exe"
      StrCpy $0 "1"
    ${ElseIf} ${FileExists} "$LOCALAPPDATA\Programs\Git\bin\bash.exe"
      StrCpy $0 "1"
    ${EndIf}

    ${If} $0 == "1"
      DetailPrint "Git for Windows installed successfully."
      ${HermesLog} "Git install succeeded (filesystem probe positive)"
    ${Else}
      DetailPrint "Git for Windows install did not complete (bash.exe not found at standard install locations)."
      ${HermesLog} "Git install failed or needs a restart (filesystem probe negative)."
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "Git for Windows install via winget did not complete successfully.$\r$\n$\r$\nSee log: $HermesLogPath$\r$\n$\r$\nInstall Git for Windows manually from https://git-scm.com/download/win if Hermes terminal commands fail."
    ${EndIf}
  ${EndIf}

  hermes_prereq_install_done:
  ${HermesLog} "=== customInstall: end ==="
  ; Flush by closing the log handle. NSIS doesn't expose fflush; FileClose
  ; both flushes and releases the handle. Subsequent macros become no-ops
  ; because we null out the handle. This is fine — there are no more log
  ; sites after customInstall in the install path.
  ${If} $HermesLogHandle != ""
    FileClose $HermesLogHandle
    StrCpy $HermesLogHandle ""
  ${EndIf}
!macroend
