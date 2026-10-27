!include LogicLib.nsh
!include "Win\RestartManager.nsh"

!define /ifndef LATTICETERM_UPDATE_WAIT_ATTEMPTS 80
!define /ifndef LATTICETERM_UPDATE_WAIT_INTERVAL_MS 250

; The updater launches NSIS immediately before exiting. Restart Manager can
; race that exit and report a failed shutdown for an already-stopping app.
; Give only in-app updates a bounded grace period. Do not kill processes or
; bypass Tauri's normal running-app check when a process remains or RM fails.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode != 1
    Goto lattice_update_wait_skip
  ${EndIf}
  Push $R0
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4

  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $0 = 0
      StrCpy $4 0
      lattice_update_wait:
        ; RmGetList uses in/out counts: reset them on every poll.
        StrCpy $1 0
        StrCpy $2 0
        StrCpy $3 0
        System::Call 'RSTRTMGR::RmGetList(i R0, *i .r1, *i r2, p 0, *i .r3) i .r0'
        ${If} $0 != 234 ; ERROR_MORE_DATA: at least one process still uses it
          Goto lattice_update_wait_done
        ${EndIf}
        ${If} $4 >= ${LATTICETERM_UPDATE_WAIT_ATTEMPTS}
          Goto lattice_update_wait_done
        ${EndIf}
        Sleep ${LATTICETERM_UPDATE_WAIT_INTERVAL_MS}
        IntOp $4 $4 + 1
        Goto lattice_update_wait
    ${EndIf}
    lattice_update_wait_done:
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}

  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R0
  lattice_update_wait_skip:
!macroend
