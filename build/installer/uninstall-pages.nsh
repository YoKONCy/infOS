; 由 customUnWelcomePage 展开后载入，此时 MUI 工厂已存在；不修改依赖中的模板文件。
!macroundef MUI_UNPAGE_INSTFILES
!macro MUI_UNPAGE_INSTFILES
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !insertmacro InfosUninstallModeFunctions
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.InfosProgressShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.InfosProgressLeave
  !insertmacro MUI_UNPAGE_INIT
  !insertmacro MUI_PAGEDECLARATION_INSTFILES
!macroend

!macroundef MUI_UNPAGE_FINISH
!macro MUI_UNPAGE_FINISH
  UninstPage custom un.InfosFinishCreate
!macroend
