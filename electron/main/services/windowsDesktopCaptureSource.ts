/**
 * @file 桥接的窗口截图（C# partial，与 windowsDesktopSource.ts 拼成同一份源码）。
 *
 * 只读请求 `capture`：按 `method` 截取目标窗口自身的画面，写成原始 BGRA 像素文件，
 * 由 TS 侧（desktopWindowCapture.ts）检测黑帧并决定是否换下一种方法：
 * - `printwindow`：PrintWindow + PW_RENDERFULLCONTENT，窗口被遮挡也能截到；
 * - `wgc`：Windows.Graphics.Capture（视觉助手里实现），用于 PrintWindow 截出黑屏的界面（UWP、WinUI、DirectComposition）。
 * 两者都裁到 DWM 的可见边框（DWMWA_EXTENDED_FRAME_BOUNDS），不含透明的缩放边。
 *
 * 移植来源：Yu-tao-Li/dsh-computer-use-win `scripts/windows-uia.ps1` 的 Try-PrintWindowCapture
 * 与窗口截图退路（MIT；Copyright (c) 2026 Yu-tao-Li；Copyright (c) 2026 cgissing），
 * 改为 C# 并输出原始像素。完整许可见仓库根目录 THIRD_PARTY_NOTICES.md。
 *
 * @platform WINDOWS
 */
export const WINDOWS_DESKTOP_CAPTURE_PART = String.raw`
public static partial class InfOSDesktop
{
  [DllImport("user32.dll")]
  static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")]
  static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);

  // 窗口可见边框（物理像素）；取不到时用 GetWindowRect。
  static Rect FrameRect(IntPtr hwnd)
  {
    Rect window;
    GetWindowRect(hwnd, out window);
    Rect frame;
    try
    {
      if (DwmGetWindowAttribute(hwnd, 9, out frame, Marshal.SizeOf(typeof(Rect))) == 0 && frame.right > frame.left && frame.bottom > frame.top)
        return frame;
    }
    catch (DllNotFoundException)
    {
    }

    return window;
  }

  static object RectObject(Rect r)
  {
    return new
    {
      x = r.left,
      y = r.top,
      width = r.right - r.left,
      height = r.bottom - r.top
    };
  }

  // 把 32 位位图按行写成紧凑的 BGRA 文件（去掉行尾对齐）。
  static void WritePixels(System.Drawing.Bitmap bitmap, System.Drawing.Rectangle area, string path)
  {
    System.Drawing.Imaging.BitmapData data = bitmap.LockBits(area, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    try
    {
      byte[] row = new byte[area.Width * 4];
      using (FileStream file = new FileStream(path, FileMode.Create, FileAccess.Write))
        for (int y = 0; y < area.Height; y++)
        {
          Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), row, 0, row.Length);
          file.Write(row, 0, row.Length);
        }
    }
    finally
    {
      bitmap.UnlockBits(data);
    }
  }

  static object CaptureWindow(Dictionary<string, object> p)
  {
    IntPtr hwnd = Target(p);
    if (IsIconic(hwnd))
      throw new Exception("DESKTOP_WINDOW_MINIMIZED: 目标窗口已最小化");
    string path = S(p, "path");
    string method = S(p, "method", "printwindow");
    Rect window;
    GetWindowRect(hwnd, out window);
    Rect frame = FrameRect(hwnd);
    if (method == "wgc")
    {
      string size = (string)VisionCall(p, "CaptureWindow", new object[] { hwnd.ToInt64(), path, 3000 }, "DESKTOP_CAPTURE_WGC_FAILED", 8000);
      if (size == null)
        throw new Exception("DESKTOP_CAPTURE_WGC_FAILED: 没有收到窗口画面");
      string[] parts = size.Split(',');
      int width = int.Parse(parts[0]), height = int.Parse(parts[1]);
      // WGC 的画面对应窗口可见区域；尺寸与边框不一致时以画面为准，原点取可见边框左上角。
      Rect captured = new Rect { left = frame.left, top = frame.top, right = frame.left + width, bottom = frame.top + height };
      return new { width = width, height = height, rect = RectObject(captured), method = "wgc" };
    }

    int fullWidth = window.right - window.left, fullHeight = window.bottom - window.top;
    if (fullWidth <= 0 || fullHeight <= 0)
      throw new Exception("DESKTOP_CAPTURE_PRINTWINDOW_FAILED: 窗口没有可截取的区域");
    Check();
    using (System.Drawing.Bitmap bitmap = new System.Drawing.Bitmap(fullWidth, fullHeight, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
    {
      bool ok;
      using (System.Drawing.Graphics graphics = System.Drawing.Graphics.FromImage(bitmap))
      {
        IntPtr hdc = graphics.GetHdc();
        try
        {
          ok = PrintWindow(hwnd, hdc, 2);
        }
        finally
        {
          graphics.ReleaseHdc(hdc);
        }
      }

      if (!ok)
        throw new Exception("DESKTOP_CAPTURE_PRINTWINDOW_FAILED: PrintWindow 调用失败");
      int left = Math.Max(0, frame.left - window.left), top = Math.Max(0, frame.top - window.top);
      int right = Math.Min(fullWidth, frame.right - window.left), bottom = Math.Min(fullHeight, frame.bottom - window.top);
      if (right <= left || bottom <= top)
      {
        left = 0;
        top = 0;
        right = fullWidth;
        bottom = fullHeight;
      }

      WritePixels(bitmap, new System.Drawing.Rectangle(left, top, right - left, bottom - top), path);
      Rect captured = new Rect { left = window.left + left, top = window.top + top, right = window.left + right, bottom = window.top + bottom };
      return new { width = right - left, height = bottom - top, rect = RectObject(captured), method = "printwindow" };
    }
  }
}
`
