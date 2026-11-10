/**
 * @file 桥接的窗口状态与切前台（C# partial，与 windowsDesktopSource.ts 拼成同一份源码）。
 * 从 windowsDesktopSource.ts 原样挪出，减少合并上游时的冲突。
 *
 * - `State`：目标窗口是否最小化、被遮挡、属于权限更高的程序（截不到图或操作不了时说明原因）；
 * - `Activate`：把目标窗口切到前台，直接切换失败时临时挂接前台线程的输入队列再试。
 *
 * @platform WINDOWS
 */
export const WINDOWS_DESKTOP_WINDOW_STATE_PART = String.raw`
public static partial class InfOSDesktop
{
  [DllImport("user32.dll")]
  static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern bool AttachThreadInput(uint attach, uint to, bool enable);
  [DllImport("user32.dll")]
  static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("dwmapi.dll")]
  static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int returned);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  // 目标窗口当前状态：截不到图或操作不了时据此说明原因（最小化、被遮挡、权限更高的程序）。
  static object State(IntPtr hwnd)
  {
    Rect target;
    GetWindowRect(hwnd, out target);
    bool occluded = false;
    // 沿 Z 序向上找可见、未最小化、未被 DWM 隐藏且与目标相交的顶层窗口。
    for (IntPtr above = GetWindow(hwnd, 3); above != IntPtr.Zero && !occluded; above = GetWindow(above, 3))
    {
      if (!IsWindowVisible(above) || IsIconic(above))
        continue;
      int cloaked = 0;
      try
      {
        DwmGetWindowAttribute(above, 14, out cloaked, 4);
      }
      catch (DllNotFoundException)
      {
      }

      if (cloaked != 0)
        continue;
      Rect r;
      GetWindowRect(above, out r);
      occluded = r.left < target.right && r.right > target.left && r.top < target.bottom && r.bottom > target.top && r.right - r.left > 1 && r.bottom - r.top > 1;
    }

    return new
    {
      minimized = IsIconic(hwnd),
      occluded = occluded,
      elevated = Elevated(hwnd)
    };
  }

  // 目标进程以更高权限运行（例如管理员）时，Windows 会拦下普通权限的模拟输入。
  static bool Elevated(IntPtr hwnd)
  {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero)
      return Marshal.GetLastWin32Error() == 5;
    try
    {
      IntPtr token;
      if (!OpenProcessToken(process, 0x0008, out token))
        return Marshal.GetLastWin32Error() == 5;
      try
      {
        int elevated, returned;
        return GetTokenInformation(token, 20, out elevated, 4, out returned) && elevated != 0 && !SelfElevated;
      }
      finally
      {
        CloseHandle(token);
      }
    }
    finally
    {
      CloseHandle(process);
    }
  }

  static readonly bool SelfElevated = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);

  // 把目标窗口切到前台：先还原最小化，直接切换失败时临时挂接前台线程的输入队列再试，最后核对结果。
  static object Activate(IntPtr hwnd)
  {
    if (IsIconic(hwnd))
      ShowWindow(hwnd, 9);
    if (GetForegroundWindow() != hwnd && !SetForegroundWindow(hwnd))
    {
      uint ignored;
      uint self = GetCurrentThreadId();
      uint front = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
      bool attached = front != 0 && front != self && AttachThreadInput(self, front, true);
      try
      {
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
      }
      finally
      {
        if (attached)
          AttachThreadInput(self, front, false);
      }
    }

    for (int waited = 0; GetForegroundWindow() != hwnd && waited < 300; waited += 50)
      Thread.Sleep(50);
    if (GetForegroundWindow() != hwnd)
      throw new Exception("DESKTOP_FOCUS_DENIED: Windows 没有允许把目标窗口切到前台");
    return Window(hwnd);
  }
}
`
