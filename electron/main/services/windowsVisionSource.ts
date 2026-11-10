/**
 * @file Windows 视觉助手的 C# 源码：文字识别（Windows.Media.Ocr）与窗口截图（Windows.Graphics.Capture）。
 *
 * 这部分要引用 WinRT 元数据（`*.winmd`），PowerShell 的 `Add-Type` 无法引用，所以单独用
 * .NET Framework 自带的 `csc.exe` 编译成缓存 DLL（见 windowsVisionHelper.ts），再由桥接按需加载。
 * 只用 C# 5 语法（csc.exe 4.x 的上限）；对外只暴露字符串等普通类型，桥接用反射调用，
 * 编译失败时桥接其他功能照常可用。
 *
 * 移植来源：Yu-tao-Li/dsh-computer-use-win `scripts/windows-uia.ps1` 中的 OCR 助手
 * （WaitOp 等待 WinRT 异步、按行和词输出框的文本格式），MIT 许可：
 * Copyright (c) 2026 Yu-tao-Li；Copyright (c) 2026 cgissing。
 * 改动：输入改为原始 BGRA 像素文件（不经 PNG 编解码），可指定识别语言，失败时给出稳定错误码。
 * 窗口截图的思路同样来自 dsh（PrintWindow 截出黑屏时改用 WGC），实现改写为 .NET Framework 可编译的写法：
 * 经 IGraphicsCaptureItemInterop 按 HWND 创建捕获项、自由线程帧池轮询一帧、
 * SoftwareBitmap.CreateCopyFromSurfaceAsync 取像素，不依赖 .NET Core 引用包。
 * 完整许可见仓库根目录 THIRD_PARTY_NOTICES.md。
 *
 * @platform WINDOWS
 */
export const WINDOWS_VISION_SOURCE = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

public static class InfOSVision
{
  // 只读系统公开的媒体标题；不读取字幕、封面或播放凭据。
  public static string MediaTitles()
  {
    var manager = Wait(Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
    StringBuilder output = new StringBuilder();
    int count = 0;
    foreach (var session in manager.GetSessions())
    {
      if (++count > 16) break;
      try {
        var properties = Wait(session.TryGetMediaPropertiesAsync());
        output.Append(Clean(session.SourceAppUserModelId)).Append('\t').Append(Clean(properties.Title)).Append('\t')
          .Append(session.GetPlaybackInfo().PlaybackStatus == Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? "playing" : "paused").Append('\t')
          .Append(Convert.ToString((object)session.GetPlaybackInfo().PlaybackType)).Append('\n');
      } catch {}
    }
    return output.ToString();
  }
  // 等待 WinRT 异步操作；不依赖 System.Runtime.WindowsRuntime 的 AsTask（在 csc 4.x 下无法解析）。
  static R Wait<R>(IAsyncOperation<R> operation)
  {
    TaskCompletionSource<R> done = new TaskCompletionSource<R>();
    operation.Completed = (op, status) =>
    {
      try
      {
        if (status == AsyncStatus.Completed)
          done.TrySetResult(op.GetResults());
        else
          done.TrySetException(new Exception("WinRT async " + status));
      }
      catch (Exception error)
      {
        done.TrySetException(error);
      }
    };
    return done.Task.GetAwaiter().GetResult();
  }

  static SoftwareBitmap Bitmap(string path, int width, int height)
  {
    byte[] pixels = File.ReadAllBytes(path);
    if (width <= 0 || height <= 0 || pixels.Length < width * height * 4)
      throw new Exception("DESKTOP_OCR_FAILED: 图片数据不完整");
    DataWriter writer = new DataWriter();
    writer.WriteBytes(pixels);
    return SoftwareBitmap.CreateCopyFromBuffer(writer.DetachBuffer(), BitmapPixelFormat.Bgra8, width, height);
  }

  static OcrEngine Engine(string language)
  {
    OcrEngine engine = null;
    if (!string.IsNullOrEmpty(language))
    {
      Language wanted = new Language(language);
      if (!OcrEngine.IsLanguageSupported(wanted))
        throw new Exception("DESKTOP_OCR_NO_LANGUAGE: 系统没有安装 " + language + " 的文字识别语言包");
      engine = OcrEngine.TryCreateFromLanguage(wanted);
    }
    else
    {
      engine = OcrEngine.TryCreateFromUserProfileLanguages();
      if (engine == null)
        foreach (Language available in OcrEngine.AvailableRecognizerLanguages)
        {
          engine = OcrEngine.TryCreateFromLanguage(available);
          if (engine != null)
            break;
        }
    }

    if (engine == null)
      throw new Exception("DESKTOP_OCR_NO_LANGUAGE: 系统没有安装任何文字识别语言包");
    return engine;
  }

  /// <summary>
  /// 识别原始 BGRA 像素文件里的文字。返回按行的制表符文本：
  /// LANG\t语言；LINE\t行文字\t词@x,y,w,h;词@x,y,w,h;...（坐标为输入图片像素）。
  /// </summary>
  public static string Recognize(string path, int width, int height, string language)
  {
    OcrEngine engine = Engine(language);
    if (width > OcrEngine.MaxImageDimension || height > OcrEngine.MaxImageDimension)
      throw new Exception("DESKTOP_OCR_FAILED: 图片超过文字识别的尺寸上限 " + OcrEngine.MaxImageDimension);
    using (SoftwareBitmap bitmap = Bitmap(path, width, height))
    {
      OcrResult result = Wait(engine.RecognizeAsync(bitmap));
      StringBuilder output = new StringBuilder();
      output.Append("LANG\t").Append(engine.RecognizerLanguage.LanguageTag).Append('\n');
      foreach (OcrLine line in result.Lines)
      {
        output.Append("LINE\t").Append(Clean(line.Text)).Append('\t');
        foreach (OcrWord word in line.Words)
        {
          Rect r = word.BoundingRect;
          output.Append(Clean(word.Text).Replace(";", " ").Replace("@", " ")).Append('@')
            .Append((int)Math.Round(r.X)).Append(',').Append((int)Math.Round(r.Y)).Append(',')
            .Append((int)Math.Round(r.Width)).Append(',').Append((int)Math.Round(r.Height)).Append(';');
        }

        output.Append('\n');
      }

      return output.ToString();
    }
  }

  static string Clean(string value)
  {
    return (value ?? "").Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
  }

  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IGraphicsCaptureItemInterop
  {
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
  }

  [DllImport("d3d11.dll")]
  static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint count, uint sdk, out IntPtr device, out int level, out IntPtr context);
  [DllImport("d3d11.dll")]
  static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr graphics);
  [DllImport("combase.dll", CharSet = CharSet.Unicode)]
  static extern int WindowsCreateString(string value, int length, out IntPtr handle);
  [DllImport("combase.dll")]
  static extern int WindowsDeleteString(IntPtr handle);
  [DllImport("combase.dll")]
  static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

  static GraphicsCaptureItem CaptureItem(IntPtr hwnd)
  {
    string name = "Windows.Graphics.Capture.GraphicsCaptureItem";
    Guid interopId = typeof(IGraphicsCaptureItemInterop).GUID;
    Guid itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    IntPtr className, factory;
    Marshal.ThrowExceptionForHR(WindowsCreateString(name, name.Length, out className));
    try
    {
      Marshal.ThrowExceptionForHR(RoGetActivationFactory(className, ref interopId, out factory));
    }
    finally
    {
      WindowsDeleteString(className);
    }

    try
    {
      IGraphicsCaptureItemInterop interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factory);
      IntPtr item = interop.CreateForWindow(hwnd, ref itemId);
      try
      {
        return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(item);
      }
      finally
      {
        Marshal.Release(item);
      }
    }
    finally
    {
      Marshal.Release(factory);
    }
  }

  static IDirect3DDevice Device()
  {
    IntPtr device, context, dxgi, graphics;
    int level;
    // D3D_DRIVER_TYPE_HARDWARE，D3D11_CREATE_DEVICE_BGRA_SUPPORT
    Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
    try
    {
      Guid dxgiId = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
      Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref dxgiId, out dxgi));
      try
      {
        Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out graphics));
        try
        {
          return (IDirect3DDevice)Marshal.GetObjectForIUnknown(graphics);
        }
        finally
        {
          Marshal.Release(graphics);
        }
      }
      finally
      {
        Marshal.Release(dxgi);
      }
    }
    finally
    {
      Marshal.Release(context);
      Marshal.Release(device);
    }
  }

  /// <summary>
  /// 用 Windows.Graphics.Capture 截取窗口一帧，写成原始 BGRA 文件，返回 "宽,高"；超时没收到画面返回 null。
  /// </summary>
  public static string CaptureWindow(long hwnd, string path, int timeoutMs)
  {
    if (!GraphicsCaptureSession.IsSupported())
      throw new Exception("DESKTOP_CAPTURE_WGC_FAILED: 系统不支持 Windows.Graphics.Capture（需要 Windows 10 1903 或更新版本）");
    GraphicsCaptureItem item = CaptureItem(new IntPtr(hwnd));
    using (IDirect3DDevice device = Device())
    using (Direct3D11CaptureFramePool pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size))
    using (GraphicsCaptureSession session = pool.CreateCaptureSession(item))
    {
      // 不画鼠标；去掉黄色边框需要系统授权，失败时保留边框。
      try
      {
        session.IsCursorCaptureEnabled = false;
      }
      catch
      {
      }

      try
      {
        session.IsBorderRequired = false;
      }
      catch
      {
      }

      session.StartCapture();
      for (int waited = 0; waited < timeoutMs; waited += 20)
      {
        using (Direct3D11CaptureFrame frame = pool.TryGetNextFrame())
        {
          if (frame != null)
            using (SoftwareBitmap bitmap = Wait(SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Premultiplied)))
            {
              int width = bitmap.PixelWidth, height = bitmap.PixelHeight;
              Windows.Storage.Streams.Buffer buffer = new Windows.Storage.Streams.Buffer((uint)(width * height * 4));
              bitmap.CopyToBuffer(buffer);
              byte[] pixels = new byte[buffer.Length];
              DataReader.FromBuffer(buffer).ReadBytes(pixels);
              File.WriteAllBytes(path, pixels);
              return width + "," + height;
            }
        }

        Thread.Sleep(20);
      }
    }

    return null;
  }

  /// <summary>已安装的识别语言（BCP-47 标签，分号分隔）。</summary>
  public static string Languages()
  {
    StringBuilder output = new StringBuilder();
    foreach (Language language in OcrEngine.AvailableRecognizerLanguages)
      output.Append(language.LanguageTag).Append(';');
    return output.ToString();
  }
}
`
