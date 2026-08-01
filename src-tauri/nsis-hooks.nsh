; Preserve the user-owned library beside the executable during NSIS upgrades.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\资料终端数据\file-terminal.db" 0 done
  IfFileExists "$INSTDIR\资料终端数据.install-backup\*.*" 0 backup
  Goto done
backup:
  Rename "$INSTDIR\资料终端数据" "$INSTDIR\资料终端数据.install-backup"
done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\资料终端数据.install-backup\file-terminal.db" 0 done
  IfFileExists "$INSTDIR\资料终端数据\file-terminal.db" 0 restore
  IfFileExists "$INSTDIR\资料终端数据\*.*" 0 remove-empty
  Goto done
remove-empty:
  RMDir "$INSTDIR\资料终端数据"
restore:
  Rename "$INSTDIR\资料终端数据.install-backup" "$INSTDIR\资料终端数据"
done:
!macroend
