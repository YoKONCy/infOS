// 安装展示层：文件部署、提权、升级与取消始终交给 NSIS。
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <shellapi.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <string>
#include <vector>
#include <algorithm>
#include <random>
#include <memory>

struct Stack { Stack* next; wchar_t text[1]; };
struct Args {
  Stack** stack;
  std::wstring pop() {
    if (!*stack) return {};
    Stack* item = *stack;
    std::wstring value(item->text);
    *stack = item->next;
    GlobalFree(item);
    return value;
  }
  HWND window() { return reinterpret_cast<HWND>(wcstoull(pop().c_str(), nullptr, 0)); }
  int number() { return _wtoi(pop().c_str()); }
};
static HWND host, page, progressBar, progressStatus, progressTitle, details, detailButton, overlay, tipButton;
static HBRUSH background, retentionBackground;
static HFONT bodyFont, titleFont, smallFont;
static std::unique_ptr<Gdiplus::Image> art, brand;
static ULONG_PTR gdip;
static double scale = 1;
static bool reduced = false, detailOpen = false, progressing = false;
static bool active = true;
static bool bufferedPainting = false;
static int progressPercent = 0;
static std::wstring progressText;
static ULONGLONG pausedAt = 0;
static std::wstring version, caption, subtitle, footer, tipLabel, nextLabel, assetDirectory;
static std::wstring scene;
static std::vector<std::wstring> stages;
static std::vector<std::wstring> tips;
static std::vector<int> bag;
static int tip = -1, nextTip = -1;
static ULONGLONG tipAt = 0, tipSwap = 0, entered = 0;
static std::mt19937 randomEngine{std::random_device{}()};
static HBITMAP previousImage, nextImage;
static std::vector<HWND> hiddenControls;
static std::vector<HWND> welcomeControls, optionsControls;
static int px(int n) { return static_cast<int>(n * scale + .5); }
static RECT box(int x, int y, int w, int h) { return {px(x), px(y), px(x+w), px(y+h)}; }
static void move(HWND window, int x, int y, int w, int h) { if (window) SetWindowPos(window, nullptr, px(x),px(y),px(w),px(h), SWP_NOZORDER|SWP_NOACTIVATE); }
static COLORREF blend(COLORREF color, double opacity) {
  return RGB(18+(GetRValue(color)-18)*opacity, 23+(GetGValue(color)-23)*opacity, 34+(GetBValue(color)-34)*opacity);
}
static void fill(HDC dc, RECT rect, COLORREF color) {
  HBRUSH brush = CreateSolidBrush(color); FillRect(dc, &rect, brush); DeleteObject(brush);
}
static void text(HDC dc, const std::wstring& value, RECT rect, HFONT font, COLORREF color, UINT flags = DT_LEFT|DT_VCENTER|DT_SINGLELINE|DT_END_ELLIPSIS) {
  const auto old = SelectObject(dc, font); SetTextColor(dc,color); SetBkMode(dc,TRANSPARENT);
  DrawTextW(dc,value.c_str(),-1,&rect,flags); SelectObject(dc,old);
}
static void releaseImage(HBITMAP& image) { if (image) DeleteObject(image); image = nullptr; }
static int pickTip() {
  if (tips.empty()) return -1;
  if (bag.empty()) {
    for (int i=0; i<static_cast<int>(tips.size()); ++i) bag.push_back(i);
    std::shuffle(bag.begin(),bag.end(),randomEngine);
    if (bag.size()>1 && bag.back()==tip) std::swap(bag.front(),bag.back());
  }
  const int result=bag.back(); bag.pop_back(); return result;
}
static void changeTip() {
  if (tipSwap || tips.empty()) return;
  nextTip=pickTip(); tipSwap=GetTickCount64();
  tipAt=tipSwap+9000+randomEngine()%4001;
}
static bool readProgress() {
  if(!IsWindow(progressBar) || !IsWindow(progressStatus)) return false;
  // 先读取 NSIS 状态，绘制时只使用本轮快照，避免清屏后等待控件消息。
  PBRANGE range{}; SendMessageW(progressBar,PBM_GETRANGE,TRUE,reinterpret_cast<LPARAM>(&range));
  const auto pos=SendMessageW(progressBar,PBM_GETPOS,0,0);
  const int percent=range.iHigh>range.iLow ? std::clamp(static_cast<int>((pos-range.iLow)*100/(range.iHigh-range.iLow)),0,100) : 0;
  wchar_t status[2048]{}; GetWindowTextW(progressStatus,status,2048);
  const bool changed=percent!=progressPercent || progressText!=status;
  progressPercent=percent; progressText=status;
  return changed;
}
static void paintPage(HDC dc) {
  RECT client; GetClientRect(page,&client); FillRect(dc,&client,background);
  {
    // 先结束 GDI+ 位图绘制，再由 GDI 绘制文字和进度，保持提交顺序一致。
    Gdiplus::Graphics graphics(dc);
    graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
    if (art && art->GetLastStatus()==Gdiplus::Ok) graphics.DrawImage(art.get(),0,0,px(552),px(570));
    if (brand && brand->GetLastStatus()==Gdiplus::Ok) graphics.DrawImage(brand.get(),px(586),px(56),px(280),px(62));
  }
  text(dc,subtitle,box(590,129,400,24),bodyFont,RGB(160,174,197));
  text(dc,L"PEROPEROCHAT",box(30,32,250,20),smallFont,RGB(97,121,152));
  text(dc,L"01 / LINK",box(455,32,80,20),smallFont,RGB(97,121,152));
  if(scene==L"uninstall") {
    RECT card=box(586,312,410,106); fill(dc,card,RGB(25,34,49));
    HBRUSH edge=CreateSolidBrush(RGB(49,65,88)); FrameRect(dc,&card,edge); DeleteObject(edge);
    fill(dc,box(586,312,3,106),RGB(120,147,191));
  }
  if(scene==L"complete" || scene==L"failed" || scene==L"pending") {
    RECT rect=box(586,166,35,35); HBRUSH edge=CreateSolidBrush(RGB(111,146,190)); FrameRect(dc,&rect,edge); DeleteObject(edge);
    HPEN pen=CreatePen(PS_SOLID,px(2),scene==L"failed"?RGB(213,164,157):RGB(181,216,255)); const auto old=SelectObject(dc,pen);
    if(scene==L"failed") {
      MoveToEx(dc,px(603),px(174),nullptr); LineTo(dc,px(603),px(185));
      MoveToEx(dc,px(603),px(190),nullptr); LineTo(dc,px(603),px(193));
    } else if(scene==L"pending") {
      MoveToEx(dc,px(603),px(174),nullptr); LineTo(dc,px(603),px(184)); LineTo(dc,px(612),px(184));
    } else {
      MoveToEx(dc,px(594),px(184),nullptr); LineTo(dc,px(601),px(191)); LineTo(dc,px(614),px(175));
    }
    SelectObject(dc,old); DeleteObject(pen);
  }
  if (!progressing) return;
  // 安装与卸载均显示原控件的真实进度，不按时间递增或自行判定完成。
  text(dc,progressText,box(586,270,300,26),bodyFont,RGB(165,182,206));
  text(dc,std::to_wstring(progressPercent)+L"%",box(906,260,88,40),titleFont,RGB(220,233,252),DT_RIGHT|DT_VCENTER|DT_SINGLELINE);
  for(int i=0;i<32;++i) fill(dc,box(586+i*13,314,10,10), i*100<progressPercent*32 ? RGB(139,183,240) : RGB(40,50,72));
  for(int i=0;i<static_cast<int>(stages.size());++i) {
    fill(dc,box(586+i*140,351,4,4),RGB(69,87,114));
    text(dc,stages[i],box(597+i*140,340,128,26),smallFont,RGB(119,141,173));
  }
  text(dc,tipLabel,box(586,382,200,20),smallFont,RGB(140,165,202));
  double opacity=1;
  int displayedTip=tip;
  const auto now=pausedAt?pausedAt:GetTickCount64();
  if(tipSwap) {
    const auto elapsed=now>=tipSwap?now-tipSwap:0;
    if(reduced || elapsed>=140) { displayedTip=nextTip; opacity=reduced?1:std::min(1.0,(elapsed-140)/220.0); }
    else opacity=1-elapsed/140.0;
  }
  if(displayedTip>=0) text(dc,tips[displayedTip],box(586,412,410,48),bodyFont,blend(RGB(160,177,202),opacity),DT_LEFT|DT_WORDBREAK);
}
static LRESULT CALLBACK controlProc(HWND window, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR kind) {
  if(msg==BM_SETSTYLE && kind<=2) wp=(wp&~BS_TYPEMASK)|BS_OWNERDRAW;
  if(msg==WM_PAINT && kind==3) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(window,&ps); RECT rect; GetClientRect(window,&rect); FillRect(dc,&rect,background);
    fill(dc,box(0,5,13,13),RGB(102,123,154)); fill(dc,box(1,6,11,11),RGB(16,23,33));
    if(SendMessageW(window,BM_GETCHECK,0,0)==BST_CHECKED) fill(dc,box(4,9,5,5),RGB(160,200,245));
    wchar_t value[1024]{}; GetWindowTextW(window,value,1024); rect.left+=px(24);
    text(dc,value,rect,bodyFont,RGB(194,205,224));
    if(GetFocus()==window) DrawFocusRect(dc,&rect);
    EndPaint(window,&ps); return 0;
  }
  if(msg==WM_NCDESTROY) RemoveWindowSubclass(window,controlProc,1);
  return DefSubclassProc(window,msg,wp,lp);
}
static bool drawButton(DRAWITEMSTRUCT* draw) {
  if(draw->CtlType!=ODT_BUTTON) return false;
  const auto kind=reinterpret_cast<UINT_PTR>(GetPropW(draw->hwndItem,L"InfosKind"));
  RECT rect=draw->rcItem;
  const bool primary=kind==1, link=kind==2, disabled=(draw->itemState&ODS_DISABLED)!=0;
  fill(draw->hDC,rect,link?RGB(18,23,34):RGB(27,37,53));
  if(primary) {
    RECT shadow=rect; OffsetRect(&shadow,px(3),px(3)); fill(draw->hDC,shadow,RGB(69,107,156));
    rect.right-=px(3); rect.bottom-=px(3);
    if(draw->itemState&ODS_SELECTED) OffsetRect(&rect,px(2),px(2));
    fill(draw->hDC,rect,RGB(139,183,240));
  }
  if(!link) { HBRUSH brush=CreateSolidBrush(primary?RGB(182,210,243):RGB(69,84,108)); FrameRect(draw->hDC,&rect,brush); DeleteObject(brush); }
  if(draw->itemState&ODS_SELECTED) OffsetRect(&rect,px(2),px(2));
  wchar_t label[1024]{}; GetWindowTextW(draw->hwndItem,label,1024);
  text(draw->hDC,label,rect,bodyFont,disabled?RGB(100,115,139):primary?RGB(19,36,58):RGB(193,206,225),DT_CENTER|DT_VCENTER|DT_SINGLELINE);
  if(draw->itemState&ODS_FOCUS) { InflateRect(&rect,-px(4),-px(4)); DrawFocusRect(draw->hDC,&rect); }
  return true;
}
static HBITMAP snapshot() {
  if(!IsWindow(page)) return nullptr;
  HDC dc=GetDC(page), memory=CreateCompatibleDC(dc);
  RECT rect; GetClientRect(page,&rect); HBITMAP image=CreateCompatibleBitmap(dc,rect.right,rect.bottom);
  const auto old=SelectObject(memory,image);
  SendMessageW(page,WM_PRINT,reinterpret_cast<WPARAM>(memory),PRF_CLIENT|PRF_CHILDREN|PRF_ERASEBKGND);
  SelectObject(memory,old); DeleteDC(memory); ReleaseDC(page,dc); return image;
}
static void finishEnter(bool releasePrevious=true) {
  if(IsWindow(overlay)) DestroyWindow(overlay); overlay=nullptr;
  for(HWND child:hiddenControls) if(IsWindow(child)) ShowWindow(child,SW_SHOWNA);
  hiddenControls.clear(); if(releasePrevious) releaseImage(previousImage); releaseImage(nextImage);
}
static LRESULT CALLBACK overlayProc(HWND window,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_TIMER) {
    const auto duration=(previousImage?(reduced?60:90):0)+(reduced?80:180);
    if(GetTickCount64()-entered >= static_cast<ULONGLONG>(duration)) { finishEnter(); return 0; }
    InvalidateRect(window,nullptr,FALSE); return 0;
  }
  if(msg==WM_ERASEBKGND) return 1;
  if(msg==WM_PAINT) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(window,&ps); RECT rect; GetClientRect(window,&rect); FillRect(dc,&rect,background);
    const double time=static_cast<double>(GetTickCount64()-entered);
    const bool leaving=previousImage && time<(reduced?60:90);
    const double phase=leaving?1-time/(reduced?60:90):std::min(1.0,(time-(previousImage?(reduced?60:90):0))/(reduced?80:180));
    const int offset=reduced?0:px(static_cast<int>((leaving?-6:10)*(1-phase)));
    HDC memory=CreateCompatibleDC(dc); const auto old=SelectObject(memory,leaving?previousImage:nextImage);
    BLENDFUNCTION blendFunction{AC_SRC_OVER,0,static_cast<BYTE>(255*std::clamp(phase,0.0,1.0)),0};
    AlphaBlend(dc,offset,0,rect.right,rect.bottom,memory,px(576),px(170),rect.right,rect.bottom,blendFunction);
    SelectObject(memory,old); DeleteDC(memory); EndPaint(window,&ps); return 0;
  }
  return DefWindowProcW(window,msg,wp,lp);
}
static LRESULT CALLBACK pageProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(window!=page) {
    // 切页后迟到的旧窗口消息只清理自身，不能修改当前页的进度和动效状态。
    if(msg==WM_NCDESTROY) { KillTimer(window,1); RemoveWindowSubclass(window,pageProc,1); }
    return DefSubclassProc(window,msg,wp,lp);
  }
  if(msg==WM_ERASEBKGND) return 1;
  if(msg==WM_PAINT) {
    PAINTSTRUCT ps{}; HDC dc=BeginPaint(window,&ps);
    if(!IsRectEmpty(&ps.rcPaint)) {
      // 仅为失效区域离屏合成，完整帧就绪后再提交，避免背景先露出造成闪烁。
      HDC memory{};
      HPAINTBUFFER buffer=bufferedPainting ? BeginBufferedPaint(dc,&ps.rcPaint,BPBF_COMPATIBLEBITMAP,nullptr,&memory) : nullptr;
      paintPage(buffer?memory:dc);
      if(buffer) EndBufferedPaint(buffer,TRUE);
    }
    EndPaint(window,&ps); return 0;
  }
  if(msg==WM_PRINTCLIENT) {
    // 切页快照已经提供离屏 DC，直接绘制，不把截图请求写回屏幕。
    paintPage(reinterpret_cast<HDC>(wp)); return 0;
  }
  if(msg==WM_CTLCOLORSTATIC || msg==WM_CTLCOLOREDIT || msg==WM_CTLCOLORBTN) {
    if(msg==WM_CTLCOLORSTATIC && scene==L"uninstall") {
      RECT rect; GetWindowRect(reinterpret_cast<HWND>(lp),&rect); MapWindowPoints(nullptr,page,reinterpret_cast<POINT*>(&rect),2);
      if(rect.left>=px(604) && rect.top>=px(324) && rect.bottom<=px(418)) {
        SetBkColor(reinterpret_cast<HDC>(wp),RGB(25,34,49)); SetTextColor(reinterpret_cast<HDC>(wp),RGB(194,205,224));
        return reinterpret_cast<LRESULT>(retentionBackground);
      }
    }
    SetBkColor(reinterpret_cast<HDC>(wp),RGB(18,23,34)); SetTextColor(reinterpret_cast<HDC>(wp),RGB(194,205,224)); return reinterpret_cast<LRESULT>(background);
  }
  if(msg==WM_DRAWITEM && drawButton(reinterpret_cast<DRAWITEMSTRUCT*>(lp))) return TRUE;
  if(msg==WM_TIMER && wp==1 && progressing) {
    const auto now=GetTickCount64();
    const bool visible=IsWindowVisible(host) && !IsIconic(host) && active;
    if(!visible && !pausedAt) pausedAt=now;
    if(visible && pausedAt) { tipAt+=now-pausedAt; if(tipSwap) tipSwap+=now-pausedAt; pausedAt=0; }
    const bool tipMoving=tipSwap!=0;
    if(visible && now>=tipAt) changeTip();
    if(!visible) return 0;
    if(readProgress()) {
      RECT dirty=box(580,255,425,112); InvalidateRect(window,&dirty,FALSE);
    }
    if(tipMoving || tipSwap) {
      // 动画完成也要提交最后一帧，局部绘制不能提前清除其他区域的刷新状态。
      if(tipSwap && (reduced || (now>=tipSwap && now-tipSwap>=360))) { tip=nextTip; tipSwap=0; }
      RECT dirty=box(580,378,425,94); InvalidateRect(window,&dirty,FALSE);
    }
    return 0;
  }
  if(msg==WM_LBUTTONUP && progressing) {
    POINT point{static_cast<short>(LOWORD(lp)),static_cast<short>(HIWORD(lp))}; RECT rect=box(900,382,100,22);
    if(PtInRect(&rect,point)) changeTip();
  }
  if(msg==WM_COMMAND && detailButton && reinterpret_cast<HWND>(lp)==detailButton) {
    detailOpen=!detailOpen; ShowWindow(details,detailOpen?SW_SHOW:SW_HIDE); return 0;
  }
  if(msg==WM_COMMAND && tipButton && reinterpret_cast<HWND>(lp)==tipButton) { changeTip(); return 0; }
  if(msg==WM_COMMAND && LOWORD(wp)==9503 && scene==L"failed") {
    PostMessageW(host,WM_COMMAND,2,0); return 0;
  }
  if(msg==WM_NCDESTROY) {
    KillTimer(window,1); progressing=false; finishEnter(false);
    RemoveWindowSubclass(window,pageProc,1);
    if(page==window) page=nullptr;
  }
  return DefSubclassProc(window,msg,wp,lp);
}
static LRESULT CALLBACK navProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_WINDOWPOSCHANGING) {
    auto* position=reinterpret_cast<WINDOWPOS*>(lp); position->flags=(position->flags&~SWP_SHOWWINDOW)|SWP_HIDEWINDOW;
  }
  if(msg==WM_NCDESTROY) RemoveWindowSubclass(window,navProc,1);
  return DefSubclassProc(window,msg,wp,lp);
}
static LRESULT CALLBACK hostProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR) {
  if(msg==WM_ACTIVATEAPP) active=wp!=0;
  if(msg==WM_SETTINGCHANGE) { BOOL value=TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&value,0); reduced=!value; }
  if(msg==WM_ERASEBKGND) return 1;
  if(msg==WM_PAINT) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(window,&ps); RECT rect; GetClientRect(window,&rect); FillRect(dc,&rect,background);
    fill(dc,box(0,0,1040,42),RGB(19,25,35)); text(dc,caption,box(20,0,850,42),bodyFont,RGB(194,205,224));
    text(dc,L"—",box(945,0,44,42),bodyFont,RGB(138,153,176),DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    text(dc,L"×",box(989,0,44,42),bodyFont,RGB(138,153,176),DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    text(dc,footer,box(20,612,750,39),smallFont,RGB(126,141,167)); text(dc,version,box(790,612,140,39),smallFont,RGB(126,141,167),DT_RIGHT|DT_VCENTER|DT_SINGLELINE);
    EndPaint(window,&ps); return 0;
  }
  if(msg==WM_DRAWITEM && drawButton(reinterpret_cast<DRAWITEMSTRUCT*>(lp))) return TRUE;
  if(msg==WM_COMMAND && LOWORD(wp)==9502) {
    ShellExecuteW(window,L"open",(assetDirectory+L"\\license.txt").c_str(),nullptr,nullptr,SW_SHOWNORMAL); return 0;
  }
  if(msg==WM_LBUTTONDOWN) {
    const int x=static_cast<short>(LOWORD(lp)),y=static_cast<short>(HIWORD(lp));
    if(y<px(42)) {
      if(x>=px(989)) SendMessageW(window,WM_CLOSE,0,0);
      else if(x>=px(945)) ShowWindow(window,SW_MINIMIZE);
      else { ReleaseCapture(); SendMessageW(window,WM_NCLBUTTONDOWN,HTCAPTION,0); }
      return 0;
    }
  }
  if(msg==WM_NCDESTROY) {
    finishEnter(); art.reset(); brand.reset();
    DeleteObject(bodyFont); DeleteObject(titleFont); DeleteObject(smallFont); DeleteObject(background); DeleteObject(retentionBackground);
    RemoveFontResourceExW((assetDirectory+L"\\zpix.ttf").c_str(),FR_PRIVATE,nullptr);
    Gdiplus::GdiplusShutdown(gdip);
    if(bufferedPainting) { BufferedPaintUnInit(); bufferedPainting=false; }
    RemoveWindowSubclass(window,hostProc,1);
  }
  return DefSubclassProc(window,msg,wp,lp);
}
extern "C" void __cdecl Init(HWND parent,int,wchar_t*,Stack** stack,void*) {
  Args args{stack}; const auto directory=args.pop(); assetDirectory=directory; version=args.pop(); caption=args.pop(); subtitle=args.pop(); footer=args.pop(); const auto license=args.pop();
  // 子类窗口过程与计时器持续使用插件代码，固定到本次安装或卸载进程退出。
  HMODULE module{}; GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,reinterpret_cast<LPCWSTR>(&Init),&module);
  host=parent; bufferedPainting=SUCCEEDED(BufferedPaintInit());
  Gdiplus::GdiplusStartupInput input; Gdiplus::GdiplusStartup(&gdip,&input,nullptr);
  BOOL animate=TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animate,0); reduced=!animate;
  RECT work{}; SystemParametersInfoW(SPI_GETWORKAREA,0,&work,0);
  HDC dc=GetDC(parent); const double dpi=GetDeviceCaps(dc,LOGPIXELSX)/96.0; ReleaseDC(parent,dc);
  scale=std::min({dpi,(work.right-work.left-32)/1040.0,(work.bottom-work.top-32)/652.0});
  background=CreateSolidBrush(RGB(18,23,34));
  retentionBackground=CreateSolidBrush(RGB(25,34,49));
  bodyFont=CreateFontW(-px(13),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Microsoft YaHei UI");
  AddFontResourceExW((directory+L"\\zpix.ttf").c_str(),FR_PRIVATE,nullptr);
  titleFont=CreateFontW(-px(23),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Zpix");
  smallFont=CreateFontW(-px(10),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Microsoft YaHei UI");
  art=std::make_unique<Gdiplus::Image>((directory+L"\\pero.png").c_str());
  brand=std::make_unique<Gdiplus::Image>((directory+L"\\brand.png").c_str());
  SetWindowLongPtrW(parent,GWL_STYLE,(GetWindowLongPtrW(parent,GWL_STYLE)&~(WS_CAPTION|WS_THICKFRAME|WS_BORDER))|WS_CLIPCHILDREN);
  SetWindowLongPtrW(parent,GWL_EXSTYLE,GetWindowLongPtrW(parent,GWL_EXSTYLE)&~(WS_EX_DLGMODALFRAME|WS_EX_WINDOWEDGE|WS_EX_CLIENTEDGE));
  const DWORD corners=1; DwmSetWindowAttribute(parent,33,&corners,sizeof(corners));
  SetWindowPos(parent,nullptr,work.left+(work.right-work.left-px(1040))/2,work.top+(work.bottom-work.top-px(652))/2,px(1040),px(652),SWP_NOZORDER|SWP_FRAMECHANGED);
  EnumChildWindows(parent,[](HWND child,LPARAM)->BOOL { ShowWindow(child,SW_HIDE); return TRUE; },0);
  for(int id:{1,2,3}) { HWND child=GetDlgItem(parent,id); SetWindowSubclass(child,navProc,1,0); }
  SetWindowSubclass(parent,hostProc,1,0);
  HWND licenseButton=CreateWindowExW(0,L"BUTTON",license.c_str(),WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,px(940),px(614),px(84),px(34),parent,reinterpret_cast<HMENU>(9502),GetModuleHandleW(nullptr),nullptr);
  SetPropW(licenseButton,L"InfosKind",reinterpret_cast<HANDLE>(2));
  WNDCLASSW cls{}; cls.lpfnWndProc=overlayProc; cls.hInstance=GetModuleHandleW(nullptr); cls.lpszClassName=L"InfosInstallerMotion"; RegisterClassW(&cls);
}
extern "C" void __cdecl Scene(HWND,int,wchar_t*,Stack** stack,void*) {
  if(IsWindow(page)) KillTimer(page,1);
  Args args{stack}; finishEnter(false); page=args.window(); scene=args.pop(); progressing=false;
  // 新页面不能保留上一页已销毁的控件句柄，防止误拦截确认、完成或范围选择事件。
  progressBar=progressStatus=progressTitle=details=detailButton=tipButton=nullptr;
  progressPercent=0; progressText.clear();
  welcomeControls.clear(); optionsControls.clear();
  EnumChildWindows(host,[](HWND child,LPARAM)->BOOL {
    if(GetParent(child)==host && child!=page && GetDlgCtrlID(child)!=9502) ShowWindow(child,SW_HIDE);
    return TRUE;
  },0);
  SetWindowLongPtrW(page,GWL_STYLE,GetWindowLongPtrW(page,GWL_STYLE)|WS_CLIPCHILDREN);
  SetWindowSubclass(page,pageProc,1,0); move(page,0,42,1040,570); InvalidateRect(page,nullptr,TRUE);
}
extern "C" void __cdecl Control(HWND,int,wchar_t*,Stack** stack,void*) {
  Args args{stack}; HWND window=args.window(); const int x=args.number(),y=args.number(),w=args.number(),h=args.number(); const auto kind=args.pop();
  move(window,x,y,w,h); SetWindowTheme(window,L"",L"");
  SendMessageW(window,WM_SETFONT,reinterpret_cast<WPARAM>(kind==L"title"?titleFont:kind==L"small"?smallFont:bodyFont),TRUE);
  const int type=kind==L"primary"?1:kind==L"link"?2:kind==L"choice"?3:0;
  if(type<=2 && (kind==L"primary" || kind==L"link" || kind==L"button")) {
    SetWindowLongPtrW(window,GWL_STYLE,(GetWindowLongPtrW(window,GWL_STYLE)&~BS_TYPEMASK)|BS_OWNERDRAW);
    SetPropW(window,L"InfosKind",reinterpret_cast<HANDLE>(static_cast<INT_PTR>(type)));
    SetWindowSubclass(window,controlProc,1,type);
  } else if(type==3) SetWindowSubclass(window,controlProc,1,3);
}
extern "C" void __cdecl Capture(HWND,int,wchar_t*,Stack**,void*) {
  finishEnter(); if(progressing) readProgress(); previousImage=snapshot();
}
extern "C" void __cdecl Enter(HWND,int,wchar_t*,Stack**,void*) {
  if(!page) return;
  nextImage=snapshot(); if(!nextImage) { releaseImage(previousImage); return; }
  hiddenControls.clear();
  EnumChildWindows(page,[](HWND child,LPARAM)->BOOL {
    RECT rect; GetWindowRect(child,&rect); MapWindowPoints(nullptr,page,reinterpret_cast<POINT*>(&rect),2);
    if(IsWindowVisible(child) && rect.left>=px(576) && rect.top>=px(170)) { hiddenControls.push_back(child); ShowWindow(child,SW_HIDE); }
    return TRUE;
  },0);
  overlay=CreateWindowExW(0,L"InfosInstallerMotion",L"",WS_CHILD|WS_VISIBLE,px(576),px(170),px(464),px(400),page,nullptr,GetModuleHandleW(nullptr),nullptr);
  if(!overlay) { finishEnter(); return; }
  entered=GetTickCount64(); SetTimer(overlay,1,16,nullptr);
}
extern "C" void __cdecl Tips(HWND,int,wchar_t*,Stack** stack,void*) {
  Args args{stack}; tipLabel=args.pop(); nextLabel=args.pop(); tips.clear(); bag.clear();
  for(int i=0;i<6;++i) tips.push_back(args.pop());
  tip=pickTip(); tipAt=GetTickCount64()+9000+randomEngine()%4001; tipSwap=0; pausedAt=0;
}
extern "C" void __cdecl Group(HWND,int,wchar_t*,Stack** stack,void*) {
  Args args{stack}; const auto action=args.pop();
  auto& group=action==L"welcome"?welcomeControls:optionsControls;
  if(action!=L"show-options" && group.empty()) {
    for(HWND child=GetWindow(page,GW_CHILD);child;child=GetWindow(child,GW_HWNDNEXT))
      if(IsWindowVisible(child)) group.push_back(child);
  }
  for(HWND child:welcomeControls) ShowWindow(child,action==L"options"?SW_SHOWNA:SW_HIDE);
  for(HWND child:optionsControls) ShowWindow(child,action==L"show-options"?SW_SHOWNA:SW_HIDE);
}
extern "C" void __cdecl Progress(HWND,int,wchar_t*,Stack** stack,void*) {
  Args args{stack}; progressBar=GetDlgItem(page,1004); progressStatus=GetDlgItem(page,1006); details=GetDlgItem(page,1016); detailButton=GetDlgItem(page,1027);
  const auto title=args.pop(), detailLabel=args.pop();
  stages.clear(); for(int i=0;i<3;++i) stages.push_back(args.pop());
  EnumChildWindows(page,[](HWND child,LPARAM)->BOOL { ShowWindow(child,SW_HIDE); return TRUE; },0);
  progressTitle=CreateWindowExW(0,L"STATIC",title.c_str(),WS_CHILD|WS_VISIBLE,px(586),px(200),px(410),px(38),page,nullptr,GetModuleHandleW(nullptr),nullptr);
  SendMessageW(progressTitle,WM_SETFONT,reinterpret_cast<WPARAM>(titleFont),TRUE);
  move(detailButton,900,478,100,28); SetWindowTextW(detailButton,detailLabel.c_str()); ShowWindow(detailButton,SW_SHOW);
  SetWindowLongPtrW(detailButton,GWL_STYLE,(GetWindowLongPtrW(detailButton,GWL_STYLE)&~BS_TYPEMASK)|BS_OWNERDRAW); SetPropW(detailButton,L"InfosKind",reinterpret_cast<HANDLE>(2)); SetWindowSubclass(detailButton,controlProc,1,2);
  tipButton=CreateWindowExW(0,L"BUTTON",nextLabel.c_str(),WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,px(900),px(378),px(100),px(26),page,nullptr,GetModuleHandleW(nullptr),nullptr);
  SetPropW(tipButton,L"InfosKind",reinterpret_cast<HANDLE>(2));
  move(details,586,512,410,54); detailOpen=false;
  readProgress(); progressing=true; SetTimer(page,1,40,nullptr);
}
extern "C" void __cdecl Failure(HWND,int,wchar_t*,Stack** stack,void*) {
  Args args{stack}; const auto title=args.pop(), description=args.pop(), detailLabel=args.pop(), closeLabel=args.pop();
  if(!IsWindow(page) || !IsWindow(host)) return;
  // 卸载中止仍留在原进度页，保留真实详情，仅替换展示状态和关闭入口。
  finishEnter(); KillTimer(page,1); progressing=false; scene=L"failed";
  ShowWindow(tipButton,SW_HIDE);
  move(progressTitle,586,220,410,40); SetWindowTextW(progressTitle,title.c_str()); ShowWindow(progressTitle,SW_SHOWNA);
  HWND body=CreateWindowExW(0,L"STATIC",description.c_str(),WS_CHILD|WS_VISIBLE,px(586),px(276),px(410),px(80),page,nullptr,GetModuleHandleW(nullptr),nullptr);
  SendMessageW(body,WM_SETFONT,reinterpret_cast<WPARAM>(bodyFont),TRUE);
  SetWindowTextW(detailButton,detailLabel.c_str()); ShowWindow(detailButton,SW_SHOWNA);
  detailOpen=true; ShowWindow(details,SW_SHOWNA);
  HWND close=CreateWindowExW(0,L"BUTTON",closeLabel.c_str(),WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,px(586),px(400),px(410),px(48),page,reinterpret_cast<HMENU>(9503),GetModuleHandleW(nullptr),nullptr);
  SendMessageW(close,WM_SETFONT,reinterpret_cast<WPARAM>(bodyFont),TRUE);
  SetPropW(close,L"InfosKind",reinterpret_cast<HANDLE>(1)); SetWindowSubclass(close,controlProc,1,1);
  InvalidateRect(page,nullptr,FALSE);
  PostMessageW(host,WM_NEXTDLGCTL,reinterpret_cast<WPARAM>(close),TRUE);
}
