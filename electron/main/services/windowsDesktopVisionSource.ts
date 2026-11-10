/**
 * @file 桥接里调用视觉助手的部分（C# partial，与 windowsDesktopSource.ts 拼成同一份源码）。
 *
 * 视觉助手（windowsVisionSource.ts）是单独编译的 DLL，这里校验字节后加载并反射调用，
 * 只传字符串和整数。WinRT 调用放在单独的 MTA 线程里执行：桥接的执行线程是 STA，
 * 在 STA 上同步等待 WinRT 异步结果有死锁风险；超时与取消结束等待，未退出的线程另行管理。
 *
 * @platform WINDOWS
 */
export const WINDOWS_DESKTOP_VISION_PART = String.raw`
public static partial class InfOSDesktop
{
  static readonly Dictionary<string, Type> VisionTypes = new Dictionary<string, Type>();

  // 按字节加载：先算 SHA-256，与编译时记下的哈希（helperSha256）一致才加载，
  // 读取与加载之间文件被换掉也无效。同一哈希只加载一次。
  static Type VisionType(Dictionary<string, object> p)
  {
    string helper = S(p, "helper");
    string expected = S(p, "helperSha256").ToLowerInvariant();
    if (helper == "" || !File.Exists(helper))
      throw new Exception("DESKTOP_VISION_UNAVAILABLE: 视觉组件尚未准备好");
    if (expected.Length != 64)
      throw new Exception("DESKTOP_VISION_UNAVAILABLE: 视觉组件缺少校验记录，请重试");
    Type type;
    if (!VisionTypes.TryGetValue(expected, out type))
    {
      byte[] bytes = File.ReadAllBytes(helper);
      string actual;
      using (var sha = System.Security.Cryptography.SHA256.Create())
        actual = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
      if (actual != expected)
        throw new Exception("DESKTOP_VISION_UNAVAILABLE: 视觉组件文件与编译记录不一致，已拒绝加载");
      type = Assembly.Load(bytes).GetType("InfOSVision", true);
      VisionTypes[expected] = type;
    }

    return type;
  }

  sealed class VisionJob
  {
    public string Id, Output;
    public Thread Worker;
    public bool Abandoned, Completed;
  }
  static readonly object VisionGate = new object();
  static VisionJob CurrentVisionJob;

  static void CleanVisionOutput(VisionJob job)
  {
    if (job.Output == null) return;
    try { File.Delete(job.Output); } catch (IOException) {} catch (UnauthorizedAccessException) {}
  }

  // 取消只结束等待；保留工作线程身份，限制并发，迟到的截图由工作线程自己清理。
  static object VisionCall(Dictionary<string, object> p, string method, object[] args, string failure, int timeoutMs)
  {
    Type type = VisionType(p);
    VisionJob job;
    lock (VisionGate)
    {
      if (CurrentVisionJob != null && !CurrentVisionJob.Completed)
        throw new Exception("DESKTOP_VISION_BUSY");
      job = new VisionJob { Id = ActiveId, Output = method == "CaptureWindow" ? args[1] as string : null };
      CurrentVisionJob = job;
    }
    object result = null;
    Exception error = null;
    Thread worker = job.Worker = new Thread(() =>
    {
      try
      {
        result = type.GetMethod(method).Invoke(null, args);
      }
      catch (TargetInvocationException wrapped)
      {
        error = wrapped.InnerException ?? wrapped;
      }
      catch (Exception other)
      {
        error = other;
      }
      finally
      {
        lock (VisionGate)
        {
          job.Completed = true;
          if (job.Abandoned)
          {
            CleanVisionOutput(job);
            Write(new { visionWorker = "finished", visionId = job.Id });
          }
        }
      }
    });
    worker.IsBackground = true;
    worker.SetApartmentState(ApartmentState.MTA);
    worker.Start();
    bool joined = false;
    try
    {
      for (int waited = 0; !worker.Join(50); waited += 50)
      {
        Check();
        if (waited >= timeoutMs)
          throw new Exception(failure + ": 视觉组件超时");
      }
      joined = true;
    }
    finally
    {
      if (!joined) lock (VisionGate)
      {
        job.Abandoned = true;
        CleanVisionOutput(job);
        if (!job.Completed)
          Write(new { visionWorker = "abandoned", visionId = job.Id });
      }
    }

    if (error != null)
      throw new Exception(error.Message.StartsWith("DESKTOP_") ? error.Message : failure + ": " + error.Message);
    return result;
  }

  static object Ocr(Dictionary<string, object> p)
  {
    string raw = (string)VisionCall(p, "Recognize", new object[] { S(p, "path"), N(p, "width"), N(p, "height"), S(p, "language") }, "DESKTOP_OCR_FAILED", 15000);
    return new
    {
      raw = raw
    };
  }
}
`
