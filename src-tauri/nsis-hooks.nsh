; Preserve the user-owned library beside the executable during NSIS upgrades.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\资料终端数据\file-terminal.db" 0 preserve_backup
  Goto preserve_done
preserve_backup:
  IfFileExists "$INSTDIR\资料终端数据.install-backup\*.*" 0 preserve_done
  Rename "$INSTDIR\资料终端数据" "$INSTDIR\资料终端数据.install-backup"
preserve_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\资料终端数据.install-backup\file-terminal.db" 0 restore_done
  IfFileExists "$INSTDIR\资料终端数据\file-terminal.db" 0 restore_library
  IfFileExists "$INSTDIR\资料终端数据\*.*" 0 restore_empty
  Goto restore_done
restore_empty:
  RMDir "$INSTDIR\资料终端数据"
restore_library:
  Rename "$INSTDIR\资料终端数据.install-backup" "$INSTDIR\资料终端数据"
restore_done:
!macroend
