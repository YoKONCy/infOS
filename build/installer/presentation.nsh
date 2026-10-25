; 安装与卸载共用布局、品牌资源和原生控件，不复制业务删除逻辑。
!define INFOS_INSTALLER_DIR "${__FILEDIR__}"
!include "${INFOS_INSTALLER_DIR}\generated\messages.nsh"
!addplugindir /x86-unicode "${INFOS_INSTALLER_DIR}\generated"
Var InfosPage

!macro customHeader
  AutoCloseWindow true
  BrandingText " "
!macroend

!macro InfosInitialize CAPTION
  SetAutoClose true
  InitPluginsDir
  ; 卸载开始后安装目录会被移除，绘制资源必须事先释放到插件临时目录。
  File "/oname=$PLUGINSDIR\pero.png" "${INFOS_INSTALLER_DIR}\assets\pero.png"
  File "/oname=$PLUGINSDIR\brand.png" "${INFOS_INSTALLER_DIR}\assets\brand.png"
  File "/oname=$PLUGINSDIR\zpix.ttf" "${PROJECT_DIR}\packages\frontend\src\assets\fonts\zpix.ttf"
  File "/oname=$PLUGINSDIR\license.txt" "${PROJECT_DIR}\LICENSE"
  InfosSetup::Init "$PLUGINSDIR" "v${VERSION}" "infOS · ${CAPTION}" "$(InfosSubtitle)" "Windows · $(InfosEdition)" "$(InfosLicense)"
!macroend

!macro InfosControl HANDLE X Y W H KIND
  InfosSetup::Control "${HANDLE}" "${X}" "${Y}" "${W}" "${H}" "${KIND}"
!macroend
!macro InfosLabel TEXT X Y W H KIND
  ${NSD_CreateLabel} 0 0 100% 20u "${TEXT}"
  Pop $0
  !insertmacro InfosControl $0 ${X} ${Y} ${W} ${H} ${KIND}
!macroend
!macro InfosButton TEXT X Y W H KIND CALLBACK
  ${NSD_CreateButton} 0 0 100% 20u "${TEXT}"
  Pop $0
  !insertmacro InfosControl $0 ${X} ${Y} ${W} ${H} ${KIND}
  ${NSD_OnClick} $0 ${CALLBACK}
!macroend
