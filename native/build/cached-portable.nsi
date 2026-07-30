Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
WindowIcon off
CRCCheck on

!ifndef APP_DIR
  !error "APP_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef APP_ICON
  !error "APP_ICON is required"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef CACHE_ID
  !define CACHE_ID "${APP_VERSION}"
!endif
!ifndef APP_FILE_VERSION
  !define APP_FILE_VERSION "${APP_VERSION}.0"
!endif

Name "同频便携版"
OutFile "${OUTPUT_FILE}"
Icon "${APP_ICON}"
InstallDir "$TEMP\SyncedPortableApp"
SetCompressor zlib

VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey /LANG=2052 "ProductName" "同频"
VIAddVersionKey /LANG=2052 "FileDescription" "同频便携版"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "同频"

!include "FileFunc.nsh"

Section
  StrCpy $INSTDIR "$TEMP\SyncedPortableApp"
  IfFileExists "$INSTDIR\同频.exe" 0 extract
  IfFileExists "$INSTDIR\.complete-${CACHE_ID}" launch extract

extract:
  RMDir /r "$INSTDIR"
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*.*"
  FileOpen $0 "$INSTDIR\.complete-${CACHE_ID}" w
  FileWrite $0 "${CACHE_ID}"
  FileClose $0

launch:
  SetOutPath "$INSTDIR"
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "同频.exe").r1'
  ${GetParameters} $R0
  ExecWait '"$INSTDIR\同频.exe" $R0' $0
  SetErrorLevel $0
SectionEnd
