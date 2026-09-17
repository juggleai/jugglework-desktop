!macro customInit
  # The one-off 1.2.18 Windows installer used a different registry identity
  # and install directory. Recognize only that exact layout, repair its
  # unquoted uninstall command, and let electron-builder's normal old-version
  # removal migrate it in place before extracting the replacement.
  # Recover a previous installer that stopped after creating temporary bridge
  # values but before completing the standard registration. initMultiUser has
  # already read the bridged location, so reset it to the standard default
  # before revalidating the legacy identity below.
  ReadRegStr $R6 HKCU "${INSTALL_REGISTRY_KEY}" "JuggleWorkLegacyMigrationBridge"
  ${If} $R6 == "1.2.18"
    ReadRegStr $R7 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${If} $R7 == ""
      DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}
    # DisplayVersion is written only by completed standard registration. In
    # either state the marker can now be removed: incomplete bridges were
    # cleared above, while complete registration remains authoritative.
    DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" "JuggleWorkLegacyMigrationBridge"
  ${EndIf}

  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R0 == ""
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\JuggleWork" "DisplayVersion"
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\JuggleWork" "InstallLocation"
    ReadRegStr $R2 HKCU "Software\JuggleWork" "InstallPath"
    ReadRegStr $R4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\JuggleWork" "UninstallString"
    StrCpy $R3 "$LOCALAPPDATA\Programs\JuggleWork"
    StrCpy $R5 "0"
    ${If} $R4 == "$R3\uninstall.exe"
    ${OrIf} $R4 == "$\"$R3\uninstall.exe$\""
      StrCpy $R5 "1"
    ${EndIf}
    ${If} $R0 == "1.2.18"
    ${AndIf} $R1 == $R3
    ${AndIf} $R2 == $R3
    ${AndIf} $R5 == "1"
    ${AndIf} ${FileExists} "$R3\JuggleWork.exe"
    ${AndIf} ${FileExists} "$R3\uninstall.exe"
      StrCpy $INSTDIR $R3
      # Bridge the validated legacy installation into the standard keys read by
      # uninstallOldVersion. Do not define UNINSTALL_REGISTRY_KEY_2 globally:
      # that would make electron-builder execute any legacy key even when the
      # identity checks above failed.
      # Write one recovery marker before either bridge value so termination at
      # any later instruction is detected and revalidated on the next run.
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "JuggleWorkLegacyMigrationBridge" "1.2.18"
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$R3"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString" "$\"$R3\uninstall.exe$\""
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  # Standard registration and extraction completed; the bridge is no longer
  # needed. A stopped installer leaves these markers for customInit recovery.
  DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" "JuggleWorkLegacyMigrationBridge"
!macroend

!macro customUnInstall
  StrCpy $1 ""
  FileOpen $0 "$APPDATA\com.juggleai.jugglework\windows-brand-shortcut.txt" r
  IfErrors +3
    FileRead $0 $1
    FileClose $0
  ${If} $1 != ""
    Delete "$1"
  ${EndIf}
  Delete "$APPDATA\com.juggleai.jugglework\windows-brand-shortcut.txt"
!macroend
