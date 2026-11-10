/** 音量查询复用桌面桥接；只读会话峰值，不创建录音流。 */
export const WINDOWS_PERCEPTION_PART = String.raw`
public static partial class InfOSDesktop
{
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class PerceptionEnumerator {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out PDevices devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out PDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-C0A3D1E5C2DB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PDevices {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out PDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PDevice { [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value); }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PManager {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out PSessions sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PSessions {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out PSimpleSession control);
  }
  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PSimpleSession {}
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PSession {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid guid);
    [PreserveSig] int SetGroupingParam(ref Guid guid, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface PMeter { [PreserveSig] int GetPeakValue(out float value); }
  static void PRelease(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
  static object PerceptionAudio() {
    List<object> result = new List<object>();
    PEnumerator enumerator = null; PDevices devices = null;
    try {
      enumerator = (PEnumerator)new PerceptionEnumerator();
      Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0, 1, out devices));
      uint deviceCount; Marshal.ThrowExceptionForHR(devices.GetCount(out deviceCount));
      for (uint d = 0; d < Math.Min(deviceCount, 16); d++) {
        PDevice device = null; object managerObject = null; PSessions sessions = null;
        try {
          Marshal.ThrowExceptionForHR(devices.Item(d, out device));
          Guid iid = typeof(PManager).GUID;
          Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out managerObject));
          Marshal.ThrowExceptionForHR(((PManager)managerObject).GetSessionEnumerator(out sessions));
          int count; Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
          for (int i = 0; i < Math.Min(count, 128); i++) {
            PSimpleSession baseSession = null;
            try {
              Marshal.ThrowExceptionForHR(sessions.GetSession(i, out baseSession));
              PSession session = (PSession)baseSession;
              uint pid; int identity = session.GetProcessId(out pid); float peak;
              if (((PMeter)session).GetPeakValue(out peak) == 0) {
                // 多进程程序（浏览器、网易云）发声的不是开窗口的进程，要靠进程名对上。
                string name = "";
                if (peak >= 0.003f && identity == 0 && pid != 0) {
                  try { using (Process owner = Process.GetProcessById((int)pid)) name = owner.ProcessName; } catch {}
                }
                result.Add(new { pid = pid, peak = peak, certain = identity == 0 && pid != 0, name = name });
              }
            } catch { result.Add(new { pid = 0, peak = 1.0, certain = false }); }
            finally { PRelease(baseSession); }
          }
        } catch { result.Add(new { pid = 0, peak = 1.0, certain = false }); }
        finally { PRelease(sessions); PRelease(managerObject); PRelease(device); }
      }
    } catch { result.Add(new { pid = 0, peak = 1.0, certain = false }); }
    finally { PRelease(devices); PRelease(enumerator); }
    return result;
  }
  static object PerceptionSample(Dictionary<string, object> p) {
    List<string> processes = new List<string>();
    if (S(p, "background") == "true") {
      string windowsRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\') + "\\";
      int userSession = Process.GetCurrentProcess().SessionId;
      foreach (Process process in Process.GetProcesses()) {
        using (process) {
          try {
            if (process.SessionId == userSession && process.Id > 4 && processes.Count < 30 && !processes.Contains(process.ProcessName) && !process.MainModule.FileName.StartsWith(windowsRoot, StringComparison.OrdinalIgnoreCase))
              processes.Add(process.ProcessName);
          } catch {}
        }
      }
    }
    return new { active = Window(GetForegroundWindow()), audio = PerceptionAudio(), processes = processes };
  }
}
`
