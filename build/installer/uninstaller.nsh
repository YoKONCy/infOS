!define MUI_CUSTOMFUNCTION_UNGUIINIT un.InfosGuiInit
Var InfosDeleteData
Var InfosUninstallResult

!macro customUnInit
  ; 只读取原有策略用于展示，不增加清理选项，也不修改默认的数据保留行为。
  StrCpy $InfosDeleteData "0"
  StrCpy $InfosUninstallResult "0"
  ${StdUtils.TestParameter} $0 "delete-app-data"
  ${If} $0 == "true"
    StrCpy $InfosDeleteData "1"
  ${Else}
    !ifdef DELETE_APP_DATA_ON_UNINSTALL
      ${IfNot} ${isUpdated}
        StrCpy $InfosDeleteData "1"
      ${EndIf}
    !endif
  ${EndIf}
!macroend

; 函数在 MUI、安装范围与标准卸载宏完成装配后展开。
!macro InfosUninstallFunctions
Function un.InfosGuiInit
  !insertmacro InfosInitialize "$(InfosUninstaller)"
FunctionEnd
Function un.InfosAdvance
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function un.InfosCancel
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd
Function un.InfosReadyCreate
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
  InfosSetup::Scene "$InfosPage" "uninstall"
  !insertmacro InfosLabel "$(InfosUninstallTitle)" 586 200 410 40 title
  !insertmacro InfosLabel "$(InfosUninstallIntro)" 586 250 410 44 body
  ${If} $InfosDeleteData == "1"
    !insertmacro InfosLabel "$(InfosDataRequested)" 604 324 374 24 body
    !insertmacro InfosLabel "$(InfosDataRequestDescription)" 604 358 374 50 small
  ${Else}
    !insertmacro InfosLabel "$(InfosKeepData)" 604 324 374 24 body
    !insertmacro InfosLabel "$(InfosKeepDataDescription)" 604 358 374 50 small
  ${EndIf}
  !insertmacro InfosButton "$(InfosUninstall) →" 586 444 410 48 primary un.InfosAdvance
  !insertmacro InfosButton "$(InfosCancel)" 586 506 410 30 link un.InfosCancel
  !insertmacro InfosLabel "$(InfosLocation)" 586 544 86 20 small
  !insertmacro InfosLabel "$INSTDIR" 680 544 316 20 small
  InfosSetup::Enter
  nsDialogs::Show
FunctionEnd
Function un.InfosReadyLeave
  InfosSetup::Capture
FunctionEnd
Function un.InfosProgressShow
  FindWindow $InfosPage "#32770" "" $HWNDPARENT
  InfosSetup::Scene "$InfosPage" "uninstall-progress"
  InfosSetup::Tips "$(InfosTipLabel)" "$(InfosNextTip) ↻" "$(InfosUninstallTip0)" "$(InfosUninstallTip1)" "$(InfosUninstallTip2)" "$(InfosUninstallTip3)" "$(InfosUninstallTip4)" "$(InfosUninstallTip5)"
  InfosSetup::Progress "$(InfosUninstalling)" "$(InfosDetails) +" "$(InfosRemoveFiles)" "$(InfosRemoveLinks)" "$(InfosUninstallFinishStage)"
  InfosSetup::Enter
FunctionEnd
Function un.InfosProgressLeave
  IfAbort 0 infos_uninstall_capture
    SetErrorLevel 1
    InfosSetup::Failure "$(InfosUninstallIncomplete)" "$(InfosUninstallFailedDescription)" "$(InfosDetails) +" "$(InfosClose)"
    Return
  infos_uninstall_capture:
  InfosSetup::Capture
FunctionEnd
Function un.InfosFinishCreate
  ; 以实际部署目录的残留判断结果，不把进度条到顶当作卸载成功。
  StrCpy $InfosUninstallResult "0"
  IfRebootFlag infos_uninstall_reboot
  IfFileExists "$INSTDIR\*.*" infos_uninstall_remaining infos_uninstall_result
  infos_uninstall_remaining:
    StrCpy $InfosUninstallResult "1"
    Goto infos_uninstall_result
  infos_uninstall_reboot:
    StrCpy $InfosUninstallResult "2"
  infos_uninstall_result:
  ${If} $InfosUninstallResult == "1"
    SetErrorLevel 1
  ${EndIf}
  nsDialogs::Create 1018
  Pop $InfosPage
  ${If} $InfosPage == error
    Abort
  ${EndIf}
  ${If} $InfosUninstallResult == "1"
    InfosSetup::Scene "$InfosPage" "failed"
    !insertmacro InfosLabel "$(InfosUninstallIncomplete)" 586 220 410 40 title
    !insertmacro InfosLabel "$(InfosUninstallRemaining)" 586 276 410 70 body
    !insertmacro InfosLabel "$INSTDIR" 586 362 410 54 small
    !insertmacro InfosButton "$(InfosOpenLocation) ↗" 586 422 410 30 link un.InfosOpenLocation
  ${Else}
    ${If} $InfosUninstallResult == "2"
      InfosSetup::Scene "$InfosPage" "pending"
      !insertmacro InfosLabel "$(InfosUninstallReboot)" 586 220 410 40 title
      !insertmacro InfosLabel "$(InfosUninstallRebootDescription)" 586 276 410 54 body
      !insertmacro InfosButton "$(InfosRebootNow)" 586 410 410 30 link un.InfosReboot
    ${Else}
      InfosSetup::Scene "$InfosPage" "complete"
      !insertmacro InfosLabel "$(InfosUninstalled)" 586 220 410 40 title
      !insertmacro InfosLabel "$(InfosUninstalledDescription)" 586 276 410 44 body
    ${EndIf}
    ${If} $InfosDeleteData == "1"
      !insertmacro InfosLabel "$(InfosDataRequested)" 586 348 410 44 body
    ${Else}
      !insertmacro InfosLabel "$(InfosDataKept)" 586 348 410 44 body
    ${EndIf}
  ${EndIf}
  !insertmacro InfosButton "$(InfosFinish)" 586 470 410 48 primary un.InfosFinish
  InfosSetup::Enter
  nsDialogs::Show
FunctionEnd
Function un.InfosOpenLocation
  Pop $0
  ExecShell "open" "$INSTDIR"
FunctionEnd
Function un.InfosReboot
  Pop $0
  Reboot
FunctionEnd
Function un.InfosFinish
  Pop $0
  ${If} $InfosUninstallResult == "1"
    SetErrorLevel 1
  ${Else}
    SetErrorLevel 0
  ${EndIf}
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function un.onUninstFailed
  ; 此回调在关闭失败窗口时才执行；界面必须在进度页的离开回调中提前更新。
  SetErrorLevel 1
FunctionEnd
!macroend

!macro InfosUninstallModeFunctions
; 必须等 PAGE_INSTALL_MODE 声明 MultiUser.* 变量后才展开这些函数。
Function un.InfosModeShow
  ; 双重安装时仍由原多用户页面选择范围与提权，只重排它的控件。
  StrCpy $InfosPage $MultiUser.InstallModePage
  InfosSetup::Scene "$InfosPage" "uninstall-scope"
  ShowWindow $MultiUser.InstallModePage.Text ${SW_HIDE}
  !insertmacro InfosLabel "$(InfosUninstallScope)" 586 200 410 40 title
  !insertmacro InfosLabel "$(InfosUninstallScopeDescription)" 586 250 410 44 body
  !insertmacro InfosControl $MultiUser.InstallModePage.CurrentUser 586 312 410 28 choice
  !insertmacro InfosControl $MultiUser.InstallModePage.AllUsers 586 350 410 28 choice
  !insertmacro InfosControl $RadioButtonLabel1 586 390 410 54 small
  !insertmacro InfosButton "$(InfosContinue) →" 586 462 410 48 primary un.InfosAdvance
  !insertmacro InfosButton "$(InfosCancel)" 586 520 410 30 link un.InfosCancel
  InfosSetup::Enter
FunctionEnd
Function un.InfosModeLeave
  InfosSetup::Capture
FunctionEnd
!macroend

!macro customUnWelcomePage
  !insertmacro InfosUninstallFunctions
  UninstPage custom un.InfosReadyCreate un.InfosReadyLeave
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.InfosModeShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.InfosModeLeave
  !endif

  ; 在原 MUI 页面工厂上绑定展示回调，保留 electron-builder 的卸载引擎和签名流程。
  ; 不能提前绑定进度回调，否则会被前面的 PAGE_INSTALL_MODE 消耗。
  !include "${INFOS_INSTALLER_DIR}\uninstall-pages.nsh"
!macroend
