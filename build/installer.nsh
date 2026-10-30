; Explorer's right-click "Open with Breeze Code", on files, folders and the empty space inside a folder.
; SHCTX is the current user's or the machine's classes, matching how Breeze was installed.

!macro breezeShellEntry KEY ARG
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\BreezeCode" "" "Open with Breeze Code"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\BreezeCode" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\BreezeCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "${ARG}"'
!macroend

!macro customInstall
  !insertmacro breezeShellEntry "*" "%1"
  !insertmacro breezeShellEntry "Directory" "%1"
  !insertmacro breezeShellEntry "Directory\Background" "%V"
  ; Tell Explorer the menus changed, so the entry shows without signing out.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\*\shell\BreezeCode"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\BreezeCode"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\BreezeCode"
!macroend
