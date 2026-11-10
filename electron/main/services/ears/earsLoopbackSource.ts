/**
 * @file 耳朵的进程回环助手（C# 源码）：录整机声音，但排除 infOS 自己的进程树。
 *
 * 用 Windows 10 2004（19041）起提供的进程回环：`ActivateAudioInterfaceAsync` 打开虚拟设备
 * `VAD\Process_Loopback`，激活参数选 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` +
 * `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`，目标进程是 infOS 主进程。渲染进程、识别进程都是
 * 它的子进程，她的 TTS 不会进来，电影声音照常录到。
 *
 * 输出协议：
 * - 标准输出：16 kHz 单声道 float32 小端的连续裸采样。音频引擎在没有声音时可能不给数据包，助手按
 *   实际经过的时间补零，保证采样数与墙钟一致（VAD 才能判断一句话结束）。
 * - 标准错误：每行一个 JSON。`{"ready":true}` 开始录音；`{"error":"EARS_LOOPBACK_..."}` 失败原因。
 * - 标准输入关闭（主进程退出或要求停止）时结束。
 *
 * 写法参考了 Microsoft Windows-classic-samples 的 ApplicationLoopback 示例（MIT）与 NAudio 的
 * 进程回环接口声明（MIT），按本项目需要重写，许可见 THIRD_PARTY_NOTICES.md。
 *
 * @platform WINDOWS
 * @see earsLoopback.ts
 */

export const EARS_LOOPBACK_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler {
  void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation {
  void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
}

// 完成回调在系统线程上调用，必须声明为 agile。
[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject {}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref InfOSWaveFormat format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint frames);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
struct InfOSWaveFormat {
  public ushort FormatTag;
  public ushort Channels;
  public uint SamplesPerSec;
  public uint AvgBytesPerSec;
  public ushort BlockAlign;
  public ushort BitsPerSample;
  public ushort Size;
}

[StructLayout(LayoutKind.Sequential)]
struct InfOSActivationParams {
  public int ActivationType;
  public uint TargetProcessId;
  public int ProcessLoopbackMode;
}

[StructLayout(LayoutKind.Sequential)]
struct InfOSBlobVariant {
  public ushort Type;
  public ushort Reserved1;
  public ushort Reserved2;
  public ushort Reserved3;
  public uint Size;
  public IntPtr Data;
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
class InfOSActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  public readonly ManualResetEvent Done = new ManualResetEvent(false);
  public int Result = unchecked((int)0x80004005);
  public object Client;
  public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) {
    try {
      object activated;
      operation.GetActivateResult(out Result, out activated);
      Client = activated;
    } catch (Exception error) {
      Result = Marshal.GetHRForException(error);
    } finally {
      Done.Set();
    }
  }
}

public static class InfOSEarsLoopback {
  const int ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
  const int MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;
  const ushort VT_BLOB = 65;
  const uint STREAMFLAGS_LOOPBACK = 0x00020000;
  const uint STREAMFLAGS_EVENTCALLBACK = 0x00040000;
  const uint STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
  const uint STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
  const uint BUFFERFLAGS_SILENT = 0x2;

  [DllImport("Mmdevapi.dll", ExactSpelling = true)]
  static extern int ActivateAudioInterfaceAsync(
    [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
    ref Guid riid,
    IntPtr activationParams,
    IActivateAudioInterfaceCompletionHandler completionHandler,
    out IActivateAudioInterfaceAsyncOperation operation);

  static volatile bool stopping;
  static int exitCode;

  static void Report(string json) {
    try { Console.Error.WriteLine(json); Console.Error.Flush(); } catch {}
  }

  static void Fail(string code, string detail) {
    Report("{\"error\":\"" + code + ": " + detail.Replace("\\", "/").Replace("\"", "'") + "\"}");
    exitCode = 2;
  }

  /** 录音直到标准输入关闭；返回退出码（0 正常，2 失败）。 */
  public static int Run(int excludeProcessId, int sampleRate, int includeTarget) {
    // 激活与读取都放在 MTA 线程：PowerShell 主线程是 STA。
    var worker = new Thread(() => Capture(excludeProcessId, sampleRate, includeTarget));
    worker.SetApartmentState(ApartmentState.MTA);
    worker.IsBackground = true;
    worker.Start();
    var watcher = new Thread(() => {
      try {
        var input = Console.OpenStandardInput();
        var buffer = new byte[64];
        while (input.Read(buffer, 0, buffer.Length) > 0) {}
      } catch {}
      stopping = true;
    });
    watcher.IsBackground = true;
    watcher.Start();
    worker.Join();
    return exitCode;
  }

  static void Capture(int excludeProcessId, int sampleRate, int includeTarget) {
    IntPtr parameters = IntPtr.Zero, variant = IntPtr.Zero;
    IAudioClient client = null;
    try {
      var activation = new InfOSActivationParams {
        ActivationType = ACTIVATION_TYPE_PROCESS_LOOPBACK,
        TargetProcessId = (uint)excludeProcessId,
        ProcessLoopbackMode = includeTarget == 1 ? 0 : MODE_EXCLUDE_TARGET_PROCESS_TREE,
      };
      parameters = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(InfOSActivationParams)));
      Marshal.StructureToPtr(activation, parameters, false);
      var blob = new InfOSBlobVariant {
        Type = VT_BLOB,
        Size = (uint)Marshal.SizeOf(typeof(InfOSActivationParams)),
        Data = parameters,
      };
      variant = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(InfOSBlobVariant)));
      Marshal.StructureToPtr(blob, variant, false);

      var handler = new InfOSActivationHandler();
      var iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
      IActivateAudioInterfaceAsyncOperation operation;
      int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, variant, handler, out operation);
      if (hr != 0) { Fail("EARS_LOOPBACK_UNSUPPORTED", "activate 0x" + hr.ToString("X8")); return; }
      if (!handler.Done.WaitOne(5000)) { Fail("EARS_LOOPBACK_UNSUPPORTED", "activate timeout"); return; }
      if (handler.Result != 0 || handler.Client == null) {
        Fail("EARS_LOOPBACK_UNSUPPORTED", "activate result 0x" + handler.Result.ToString("X8"));
        return;
      }
      client = (IAudioClient)handler.Client;

      var format = new InfOSWaveFormat {
        FormatTag = 3, // IEEE float
        Channels = 1,
        SamplesPerSec = (uint)sampleRate,
        AvgBytesPerSec = (uint)(sampleRate * 4),
        BlockAlign = 4,
        BitsPerSample = 32,
        Size = 0,
      };
      hr = client.Initialize(0, STREAMFLAGS_LOOPBACK | STREAMFLAGS_EVENTCALLBACK | STREAMFLAGS_AUTOCONVERTPCM | STREAMFLAGS_SRC_DEFAULT_QUALITY,
        2000000, 0, ref format, IntPtr.Zero);
      if (hr != 0) { Fail("EARS_LOOPBACK_UNSUPPORTED", "initialize 0x" + hr.ToString("X8")); return; }
      var ready = new AutoResetEvent(false);
      hr = client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
      if (hr != 0) { Fail("EARS_LOOPBACK_FAILED", "event 0x" + hr.ToString("X8")); return; }
      var captureIid = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
      object service;
      hr = client.GetService(ref captureIid, out service);
      if (hr != 0) { Fail("EARS_LOOPBACK_FAILED", "service 0x" + hr.ToString("X8")); return; }
      var capture = (IAudioCaptureClient)service;
      hr = client.Start();
      if (hr != 0) { Fail("EARS_LOOPBACK_FAILED", "start 0x" + hr.ToString("X8")); return; }
      Report("{\"ready\":true,\"sampleRate\":" + sampleRate + "}");

      var output = Console.OpenStandardOutput();
      var clock = Stopwatch.StartNew();
      long written = 0;
      var bytes = new byte[sampleRate * 4];
      var zeros = new byte[sampleRate * 4];
      // 落后超过 0.3 秒就补零到只差 0.1 秒：引擎正常送包时不会补，没有声音不送包时保持连续。
      long lagLimit = sampleRate * 3 / 10, lagKeep = sampleRate / 10;
      while (!stopping) {
        ready.WaitOne(100);
        uint packet;
        while (!stopping && capture.GetNextPacketSize(out packet) == 0 && packet > 0) {
          IntPtr data; uint frames, flags; ulong devicePosition, qpcPosition;
          hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
          if (hr != 0) { Fail("EARS_LOOPBACK_FAILED", "buffer 0x" + hr.ToString("X8")); return; }
          int length = (int)frames * 4;
          if (length > bytes.Length) bytes = new byte[length];
          if ((flags & BUFFERFLAGS_SILENT) != 0) Array.Clear(bytes, 0, length);
          else Marshal.Copy(data, bytes, 0, length);
          capture.ReleaseBuffer(frames);
          output.Write(bytes, 0, length);
          written += frames;
        }
        long expected = clock.ElapsedTicks * sampleRate / Stopwatch.Frequency;
        if (expected - written > lagLimit) {
          long pad = expected - written - lagKeep;
          while (pad > 0) {
            int count = (int)Math.Min(pad, zeros.Length / 4);
            output.Write(zeros, 0, count * 4);
            pad -= count;
            written += count;
          }
        }
        output.Flush();
      }
      client.Stop();
    } catch (IOException) {
      // 主进程关掉了管道：正常结束。
    } catch (Exception error) {
      Fail("EARS_LOOPBACK_FAILED", error.GetType().Name + " " + error.Message);
    } finally {
      if (client != null) Marshal.ReleaseComObject(client);
      if (variant != IntPtr.Zero) Marshal.FreeHGlobal(variant);
      if (parameters != IntPtr.Zero) Marshal.FreeHGlobal(parameters);
    }
  }
}
`
