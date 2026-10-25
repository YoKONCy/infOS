!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "UAC.nsh"

!include "${__FILEDIR__}\presentation.nsh"

!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_GUIINIT InfosGuiInit
Var InfosPath
Var InfosDesiredPath
Var InfosScope
Var InfosShortcut
Var InfosShortcutControl
Var InfosAllUsersControl
Var InfosCurrentUserControl
Var InfosOptions
Var InfosOptionsCreated
Var InfosDestinationControl

; 保留命令行选项，并把界面上的快捷方式选择交回原安装逻辑。
!macro _InfosNoDesktop _a _b _t _f
  StrCmp "$InfosShortcut" "0" `${_t}`
  ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!undef isNoDesktopShortcut
!define isNoDesktopShortcut `"" InfosNoDesktop ""`

!macro customInit
  StrCpy $InfosShortcut "1"
  ${StdUtils.TestParameter} $0 "no-desktop-shortcut"
  ${If} $0 == "true"
    StrCpy $InfosShortcut "0"
  ${EndIf}
  StrCpy $InfosScope "$installMode"
  StrCpy $InfosDesiredPath "$INSTDIR"
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobal $InfosDesiredPath $InfosDesiredPath
    !insertmacro UAC_AsUser_GetGlobal $InfosShortcut $InfosShortcut
    StrCpy $InfosScope "all"
    !insertmacro setInstallModePerAllUsers
    StrCpy $INSTDIR "$InfosDesiredPath"
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} $InfosScope == "all"
    StrCpy $isForceMachineInstall "1"
  ${Else}
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend

; 在 electron-builder 已装配 MUI 和多用户宏后再展开函数体。
!macro InfosFunctions
Function InfosGuiInit
  !insertmacro InfosInitialize "$(InfosInstaller)"
FunctionEnd

Function InfosAdvance
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function InfosBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "$(InfosLocation)" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    ${NSD_SetText} $InfosPath "$0"
  ${EndIf}
FunctionEnd
Function InfosScopeChanged
  Pop $0
  ${NSD_GetText} $InfosPath $InfosDesiredPath
  ${NSD_GetState} $InfosAllUsersControl $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $InfosScope "all"
    !insertmacro setInstallModePerAllUsers
  ${Else}
    StrCpy $InfosScope "CurrentUser"
    !insertmacro setInstallModePerUser
  ${EndIf}
  ${NSD_SetText} $InfosPath "$INSTDIR"
FunctionEnd
Function InfosReadyCreate
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${UAC_IsAdmin}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $InfosPage
  ${If} $InfosPage == error
    Abort
  ${EndIf}
  InfosSetup::Scene "$InfosPage" "welcome"
  ; 首页与选项共用宿主，按控件组切换；原生按钮保留键盘导航。
  !insertmacro InfosLabel "$(InfosInstallTitle)" 586 200 410 38 title
  !insertmacro InfosLabel "$(InfosIntro)" 586 246 410 24 body
  !insertmacro InfosButton "$(InfosInstall) →" 586 300 410 48 primary InfosAdvance
  !insertmacro InfosButton "$(InfosOptions)" 586 362 410 30 link InfosShowOptions
  !insertmacro InfosLabel "$(InfosDestination)" 586 416 410 20 small
  !insertmacro InfosLabel "$INSTDIR" 586 440 410 42 small
  StrCpy $InfosDestinationControl $0
  StrCpy $InfosOptions "0"
  StrCpy $InfosOptionsCreated "0"
  InfosSetup::Enter
  nsDialogs::Show
FunctionEnd
Function InfosShowOptions
  Pop $0
  InfosSetup::Capture
  ${If} $InfosOptionsCreated == "1"
    InfosSetup::Group "show-options"
    StrCpy $InfosOptions "1"
    InfosSetup::Enter
    Return
  ${EndIf}
  ; 先隐藏首页控件，再创建选项；已经创建的选项在回退后仍保留输入值。
  InfosSetup::Group "welcome"
  !insertmacro InfosLabel "$(InfosOptions)" 586 180 410 38 title
  !insertmacro InfosLabel "$(InfosLocation)" 586 230 410 22 body
  ${NSD_CreateText} 0 0 100% 20u "$InfosDesiredPath"
  Pop $InfosPath
  !insertmacro InfosControl $InfosPath 586 260 315 35 body
  !insertmacro InfosButton "$(InfosBrowse)" 910 260 86 35 button InfosBrowse
  !insertmacro InfosLabel "$(InfosScope)" 586 315 410 22 body
  ${NSD_CreateRadioButton} 0 0 100% 20u "$(InfosCurrentUser)"
  Pop $InfosCurrentUserControl
  !insertmacro InfosControl $InfosCurrentUserControl 586 345 185 28 choice
  ${NSD_CreateRadioButton} 0 0 100% 20u "$(InfosAllUsers)"
  Pop $InfosAllUsersControl
  !insertmacro InfosControl $InfosAllUsersControl 790 345 206 28 choice
  ${NSD_OnClick} $InfosCurrentUserControl InfosScopeChanged
  ${NSD_OnClick} $InfosAllUsersControl InfosScopeChanged
  ${If} $InfosScope == "all"
    ${NSD_SetState} $InfosAllUsersControl ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $InfosCurrentUserControl ${BST_CHECKED}
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 20u "$(InfosShortcut)"
  Pop $InfosShortcutControl
  !insertmacro InfosControl $InfosShortcutControl 586 393 410 28 choice
  ${NSD_SetState} $InfosShortcutControl $InfosShortcut
  !insertmacro InfosButton "$(InfosBack)" 586 453 90 42 button InfosShowWelcome
  !insertmacro InfosButton "$(InfosStart) →" 690 453 306 42 primary InfosAdvance
  StrCpy $InfosOptions "1"
  StrCpy $InfosOptionsCreated "1"
  InfosSetup::Enter
FunctionEnd
Function InfosShowWelcome
  Pop $0
  ${NSD_GetText} $InfosPath $InfosDesiredPath
  ${NSD_GetState} $InfosShortcutControl $InfosShortcut
  InfosSetup::Capture
  InfosSetup::Group "options"
  ${NSD_SetText} $InfosDestinationControl "$InfosDesiredPath"
  StrCpy $InfosOptions "0"
  InfosSetup::Enter
FunctionEnd
Function InfosReadyLeave
  ${If} $InfosOptions == "1"
    ${NSD_GetText} $InfosPath $InfosDesiredPath
    ${NSD_GetState} $InfosShortcutControl $InfosShortcut
  ${EndIf}
  ${GetRoot} "$InfosDesiredPath" $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "$(InfosPathError)"
    Abort
  ${EndIf}
  ; 盘符相对路径不能交给 GetFullPathName 隐式选择当前工作目录。
  StrCpy $0 "$InfosDesiredPath" 2
  ${If} $0 != "\\"
    StrCpy $0 "$InfosDesiredPath" 1 1
    StrCpy $1 "$InfosDesiredPath" 1 2
    ${If} $0 != ":"
      MessageBox MB_ICONEXCLAMATION "$(InfosPathError)"
      Abort
    ${EndIf}
    ${If} $1 != "\"
    ${AndIf} $1 != "/"
      MessageBox MB_ICONEXCLAMATION "$(InfosPathError)"
      Abort
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$InfosDesiredPath", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    MessageBox MB_ICONEXCLAMATION "$(InfosPathError)"
    Abort
  ${EndIf}
  infos_trim_directory:
    StrLen $2 "$0"
    IntCmp $2 3 infos_trim_done infos_trim_done
    StrCpy $1 "$0" 1 -1
    StrCmp "$1" "\" 0 infos_trim_done
    StrCpy $0 "$0" -1
    Goto infos_trim_directory
  infos_trim_done:
  ${GetRoot} "$0" $2
  ${If} $0 == "$2"
  ${OrIf} $0 == "$2\"
    StrCpy $0 "$0\${APP_FILENAME}"
  ${EndIf}
  ; 现有安装目录可为用户自定义名称，重装不能追加第二层目录。
  ${IfNot} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    ${GetFileName} "$0" $1
    ${If} $1 != "${APP_FILENAME}"
      StrCpy $0 "$0\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
  StrCpy $InfosDesiredPath "$0"
  StrCpy $INSTDIR "$0"
  ${If} $InfosScope == "all"
  ${AndIfNot} ${UAC_IsAdmin}
    ShowWindow $HWNDPARENT ${SW_HIDE}
    !insertmacro UAC_RunElevated
    ${If} $0 == 0
    ${AndIf} $1 == 1
      Quit
    ${EndIf}
    ShowWindow $HWNDPARENT ${SW_SHOW}
    BringToFront
    ${If} $0 != 1223
      MessageBox MB_ICONEXCLAMATION "$(InfosElevationError)"
    ${EndIf}
    Abort
  ${EndIf}
  InfosSetup::Capture
FunctionEnd
Function InfosProgressShow
  FindWindow $InfosPage "#32770" "" $HWNDPARENT
  InfosSetup::Scene "$InfosPage" "progress"
  InfosSetup::Tips "$(InfosTipLabel)" "$(InfosNextTip) ↻" "$(InfosTip0)" "$(InfosTip1)" "$(InfosTip2)" "$(InfosTip3)" "$(InfosTip4)" "$(InfosTip5)"
  InfosSetup::Progress "$(InfosInstalling)" "$(InfosDetails) +" "$(InfosFiles)" "$(InfosRegister)" "$(InfosFinishStage)"
  InfosSetup::Enter
FunctionEnd
Function InfosApplyDirectory
  StrCpy $INSTDIR "$InfosDesiredPath"
  Abort
FunctionEnd
Function InfosProgressLeave
  InfosSetup::Capture
FunctionEnd
Function InfosFinishCreate
  nsDialogs::Create 1018
  Pop $InfosPage
  ${If} $InfosPage == error
    Abort
  ${EndIf}
  InfosSetup::Scene "$InfosPage" "complete"
  !insertmacro InfosLabel "$(InfosComplete)" 586 220 410 40 title
  !insertmacro InfosLabel "$(InfosReady)" 586 274 410 24 body
  !insertmacro InfosButton "$(InfosLaunch) →" 586 340 410 48 primary InfosLaunch
  !insertmacro InfosButton "$(InfosFinish)" 586 407 410 30 link InfosFinish
  InfosSetup::Enter
  nsDialogs::Show
FunctionEnd
Function InfosLaunch
  Pop $0
  !insertmacro StartApp
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function InfosFinish
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
!macroend
!macro customWelcomePage
  !insertmacro InfosFunctions
  Page custom InfosReadyCreate InfosReadyLeave
!macroend
!macro customPageAfterChangeDir
  Page custom InfosApplyDirectory
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW InfosProgressShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE InfosProgressLeave
!macroend
!macro customFinishPage
  Page custom InfosFinishCreate
!macroend
!else
!include "${INFOS_INSTALLER_DIR}\uninstaller.nsh"
!endif
