import { WINDOWS_DESKTOP_VISION_PART } from './windowsDesktopVisionSource'
import { WINDOWS_DESKTOP_CAPTURE_PART } from './windowsDesktopCaptureSource'
import { WINDOWS_DESKTOP_UIA_PART } from './windowsDesktopUiaSource'
import { WINDOWS_DESKTOP_HANDS_PART } from './windowsDesktopHandsSource'
import { WINDOWS_PERCEPTION_PART } from './windowsPerceptionSource'
import { WINDOWS_DESKTOP_WINDOW_STATE_PART } from './windowsDesktopWindowStateSource'

/** Windows 桥接主体（C#）；与各 partial 片段拼成完整源码。 */
const MAIN_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static partial class InfOSDesktop
{
  const long Marker = 0x494E464F;
  static readonly object OutputLock = new object ();
  static readonly object InputLock = new object ();
  static readonly BlockingCollection<Dictionary<string, object>> Requests = new BlockingCollection<Dictionary<string, object>>();
  static readonly ConcurrentDictionary<string, bool> Cancelled = new ConcurrentDictionary<string, bool>();
  static readonly ConcurrentDictionary<string, bool> Known = new ConcurrentDictionary<string, bool>();
  static readonly Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
  static readonly HashSet<ushort> HeldKeys = new HashSet<ushort>();
  static readonly HashSet<uint> HeldButtons = new HashSet<uint>();
  static volatile string ActiveId = "";
  // 只读请求（枚举窗口、观察、读取位置）不因用户输入而中断，只有注入类请求才会被用户接管打断。
  static volatile bool ActiveReadOnly;
  static HookProc MouseProc = MouseHook, KeyProc = KeyHook;
  static IntPtr MouseHandle, KeyHandle;
  static uint HookThread;
  static volatile bool Listening;
  static long LastActivity;
  static IntPtr InputWindow;
  static Timer HoldTimer;
  static bool ActionDispatched;
  [StructLayout(LayoutKind.Sequential)]
  struct Point
  {
    public int x, y;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Rect
  {
    public int left, top, right, bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct MouseHookData
  {
    public Point pt;
    public uint data, flags, time;
    public UIntPtr extra;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct KeyHookData
  {
    public uint key, scan, flags, time;
    public UIntPtr extra;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct MouseInput
  {
    public int dx, dy;
    public uint data, flags, time;
    public UIntPtr extra;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct KeyInput
  {
    public ushort key, scan;
    public uint flags, time;
    public UIntPtr extra;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct InputUnion
  {
    [FieldOffset(0)]
    public MouseInput mouse;
    [FieldOffset(0)]
    public KeyInput key;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Input
  {
    public uint type;
    public InputUnion u;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Message
  {
    public IntPtr hwnd;
    public uint message;
    public UIntPtr w;
    public IntPtr l;
    public uint time;
    public Point pt;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct LastInput
  {
    public uint size, time;
  }

  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  delegate bool EnumProc(IntPtr hwnd, IntPtr l);
  [DllImport("user32.dll")]
  static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")]
  static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")]
  static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")]
  static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")]
  static extern bool PostThreadMessage(uint thread, uint message, UIntPtr w, IntPtr l);
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumProc callback, IntPtr l);
  [DllImport("user32.dll")]
  static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")]
  static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")]
  static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LastInput input);
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")]
  static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")]
  static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  static string S(Dictionary<string, object> p, string key, string fallback = "")
  {
    object v;
    return p.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : fallback;
  }

  static int N(Dictionary<string, object> p, string key, int fallback = 0)
  {
    object v;
    return p.TryGetValue(key, out v) ? Convert.ToInt32(v) : fallback;
  }

  static void Write(object value)
  {
    lock (OutputLock)
      Console.WriteLine(new JavaScriptSerializer().Serialize(value));
  }

  static void Check()
  {
    if (Cancelled.ContainsKey(ActiveId))
      throw new Exception("DESKTOP_CANCELLED: 桌面操作已中断");
  }

  static void Activity(string kind)
  {
    if (!Listening)
      return;
    if (ActiveId != "" && !ActiveReadOnly)
      Cancelled[ActiveId] = true;
    long now = Stopwatch.GetTimestamp();
    if (kind == "move" && (now - LastActivity) * 1000 / Stopwatch.Frequency < 40)
      return;
    LastActivity = now;
    Write(new { activity = kind });
  }

  static IntPtr MouseHook(int code, IntPtr w, IntPtr l)
  {
    if (code >= 0)
    {
      MouseHookData data = (MouseHookData)Marshal.PtrToStructure(l, typeof(MouseHookData));
      if (data.extra.ToUInt64() != (ulong)Marker)
        Activity(w.ToInt32() == 0x200 ? "move" : "mouse");
    }

    return CallNextHookEx(MouseHandle, code, w, l);
  }

  static IntPtr KeyHook(int code, IntPtr w, IntPtr l)
  {
    if (code >= 0)
    {
      KeyHookData data = (KeyHookData)Marshal.PtrToStructure(l, typeof(KeyHookData));
      if (data.extra.ToUInt64() != (ulong)Marker)
        Activity("keyboard");
    }

    return CallNextHookEx(KeyHandle, code, w, l);
  }

  static object Window(IntPtr hwnd)
  {
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
      return null;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    StringBuilder title = new StringBuilder(1024);
    GetWindowText(hwnd, title, title.Capacity);
    string name = "", processGeneration = "";
    try
    {
      using (Process process = Process.GetProcessById((int)pid)) {
        name = process.ProcessName;
        processGeneration = process.Id.ToString() + ":" + process.StartTime.ToUniversalTime().Ticks.ToString();
      }
    }
    catch
    {
    }

    Rect r;
    GetWindowRect(hwnd, out r);
    // 窗口类名：护栏据此识别经典控制面板（CabinetWClass）与对话框（#32770）。
    StringBuilder className = new StringBuilder(256);
    GetClassName(hwnd, className, className.Capacity);
    return new
    {
      windowId = hwnd.ToInt64().ToString(),
      title = title.ToString(),
      processName = name,
      processGeneration = processGeneration,
      pid = pid,
      className = className.ToString(),
      bounds = new
      {
        x = r.left,
        y = r.top,
        width = r.right - r.left,
        height = r.bottom - r.top
      }
    };
  }

  static IntPtr Target(Dictionary<string, object> p)
  {
    string id = S(p, "windowId");
    IntPtr hwnd = id == "" ? GetForegroundWindow() : new IntPtr(long.Parse(id));
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
      throw new Exception("DESKTOP_WINDOW_GONE: 目标窗口已关闭");
    return hwnd;
  }

  static void Send(Input input, bool cleanup = false)
  {
    if (!cleanup)
      Check();
    if (!cleanup && InputWindow != IntPtr.Zero && GetForegroundWindow() != InputWindow)
      throw new Exception("DESKTOP_FOCUS_CHANGED: 输入目标窗口已变化，请重新观察");
    if (SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))) != 1 && !cleanup)
      throw new Exception("DESKTOP_INPUT_DENIED: 系统拒绝输入，目标应用可能具有更高权限");
    if (!cleanup)
      ActionDispatched = true;
  }

  static void Mouse(uint flags, int x = 0, int y = 0, uint data = 0, bool cleanup = false)
  {
    Input input = new Input();
    input.type = 0;
    input.u.mouse = new MouseInput
    {
      dx = x,
      dy = y,
      data = data,
      flags = flags,
      extra = new UIntPtr((ulong)Marker)
    };
    Send(input, cleanup);
  }

  static void Move(int x, int y)
  {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    if (x < left || y < top || x >= left + width || y >= top + height)
      throw new Exception("DESKTOP_COORDINATE_OUT_OF_RANGE: 坐标不在桌面范围内");
    Mouse(0x8000 | 0x4000 | 1, (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1)), (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1)));
  }

  static void Key(ushort code, bool up, bool unicode = false, bool cleanup = false)
  {
    lock (InputLock)
    {
      Input input = new Input();
      input.type = 1;
      uint extended = !unicode && IsExtendedKey(code) ? 1u : 0u;
      input.u.key = new KeyInput
      {
        key = unicode ? (ushort)0 : code,
        scan = unicode ? code : (ushort)0,
        flags = (up ? 2u : 0u) | (unicode ? 4u : extended),
        extra = new UIntPtr((ulong)Marker)
      };
      Send(input, cleanup);
      if (!unicode)
      {
        if (up)
          HeldKeys.Remove(code);
        else
          HeldKeys.Add(code);
      }
    }
  }

  static ushort KeyCode(string value)
  {
    string key = value.Trim().ToUpperInvariant();
    if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9')))
      return (ushort)key[0];
    int number;
    if (key.StartsWith("F") && int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24)
      return (ushort)(0x6F + number);
    switch (key)
    {
      case "CTRL":
      case "CONTROL":
      case "LEFTCONTROL":
        return 0x11;
      case "ALT":
      case "LEFTALT":
        return 0x12;
      case "SHIFT":
      case "LEFTSHIFT":
        return 0x10;
      case "WIN":
      case "META":
      case "SUPER":
      case "LEFTSUPER":
        return 0x5B;
      case "ENTER":
      case "RETURN":
        return 0x0D;
      case "TAB":
        return 9;
      case "ESC":
      case "ESCAPE":
        return 0x1B;
      case "SPACE":
        return 0x20;
      case "BACKSPACE":
        return 8;
      case "DELETE":
        return 0x2E;
      case "INSERT":
        return 0x2D;
      case "HOME":
        return 0x24;
      case "END":
        return 0x23;
      case "PAGEUP":
        return 0x21;
      case "PAGEDOWN":
        return 0x22;
      case "LEFT":
        return 0x25;
      case "UP":
        return 0x26;
      case "RIGHT":
        return 0x27;
      case "DOWN":
        return 0x28;
      default:
        return ExtraKeyCode(key, value);
    }
  }

  static void Release()
  {
    lock (InputLock)
    {
      foreach (ushort key in new List<ushort>(HeldKeys))
        Key(key, true, false, true);
      foreach (uint button in new List<uint>(HeldButtons))
        Mouse(button, 0, 0, 0, true);
      HeldButtons.Clear();
    }
  }

  static bool Supports(AutomationElement e, AutomationPattern pattern)
  {
    object value;
    return e.TryGetCurrentPattern(pattern, out value);
  }

  static void Dispatch(Action action)
  {
    Check();
    ActionDispatched = true;
    action();
  }

  static object ElementAction(Dictionary<string, object> p)
  {
    AutomationElement e;
    if (!Elements.TryGetValue(S(p, "elementId"), out e))
      throw new Exception("DESKTOP_ELEMENT_STALE: 请重新观察目标控件");
    IntPtr hwnd = Target(p);
    AutomationElement root = AutomationElement.FromHandle(hwnd);
    AutomationElement ancestor = e;
    bool belongs = false;
    for (int i = 0; ancestor != null && i < 64; i++, ancestor = TreeWalker.RawViewWalker.GetParent(ancestor))
      if (Automation.Compare(ancestor, root))
      {
        belongs = true;
        break;
      }

    if (!belongs || !e.Current.IsEnabled || e.Current.IsOffscreen)
      throw new Exception("DESKTOP_ELEMENT_STALE: 控件已变化或不可操作");
    object expected;
    if (p.TryGetValue("expectedElement", out expected))
    {
      var snapshot = (Dictionary<string, object>)expected;
      var bounds = (Dictionary<string, object>)snapshot["bounds"];
      var actual = e.Current.BoundingRectangle;
      if (Clip(e.Current.Name, 120) != S(snapshot, "name") || Math.Abs(actual.X - Convert.ToDouble(bounds["x"])) > 1 || Math.Abs(actual.Y - Convert.ToDouble(bounds["y"])) > 1 || Math.Abs(actual.Width - Convert.ToDouble(bounds["width"])) > 1 || Math.Abs(actual.Height - Convert.ToDouble(bounds["height"])) > 1)
        throw new Exception("DESKTOP_ELEMENT_STALE: 控件位置或内容已变化，请重新观察");
    }

    Check();
    object pattern;
    string action = S(p, "action");
    Dictionary<string, object> before = ElementState(e);
    if (action == "invoke" && e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
      Dispatch(() => ((InvokePattern)pattern).Invoke());
    else if (action == "set_value" && !e.Current.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
      Dispatch(() => ((ValuePattern)pattern).SetValue(S(p, "text")));
    else if (action == "toggle" && e.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
      Dispatch(() => ((TogglePattern)pattern).Toggle());
    else if (action == "select" && e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
      Dispatch(() => ((SelectionItemPattern)pattern).Select());
    else if (action == "expand" && e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
      Dispatch(() => ((ExpandCollapsePattern)pattern).Expand());
    else if (action == "collapse" && e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
      Dispatch(() => ((ExpandCollapsePattern)pattern).Collapse());
    else if (action == "scroll" && e.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern))
    {
      string direction = S(p, "direction", "down");
      ScrollAmount amount = N(p, "amount", 1) > 1 ? ScrollAmount.LargeIncrement : ScrollAmount.SmallIncrement;
      ScrollAmount negative = amount == ScrollAmount.LargeIncrement ? ScrollAmount.LargeDecrement : ScrollAmount.SmallDecrement;
      Dispatch(() => ((ScrollPattern)pattern).Scroll(direction == "left" ? negative : direction == "right" ? amount : ScrollAmount.NoAmount, direction == "up" ? negative : direction == "down" ? amount : ScrollAmount.NoAmount));
    }
    else
      throw new Exception("DESKTOP_PATTERN_UNSUPPORTED: 控件不支持该操作，请重新观察后选择其他方式");
    Check();
    return new
    {
      dispatched = true,
      method = "uia",
      before = before,
      after = action == "set_value" ? ValueAfter(e, S(p, "text")) : StateAfter(e)
    };
  }

  static object Execute(Dictionary<string, object> p)
  {
    string op = S(p, "operation"), action = S(p, "action");
    Check();
    if (op == "perception") return PerceptionSample(p);
    if (op == "windows")
    {
      List<object> windows = new List<object>();
      EnumWindows((hwnd, l) =>
      {
        if (IsWindowVisible(hwnd))
        {
          object info = Window(hwnd);
          if (info != null)
            windows.Add(info);
        }

        return true;
      }, IntPtr.Zero);
      return windows;
    }

    if (op == "active")
      return Window(GetForegroundWindow());
    if (op == "window")
      return Window(Target(p));
    if (op == "position")
    {
      Point point;
      GetCursorPos(out point);
      return new
      {
        x = point.x,
        y = point.y
      };
    }

    if (op == "observe")
      return Observe(p);
    if (op == "ocr")
      return Ocr(p);
    if (op == "mediaTitles")
      return VisionCall(p, "MediaTitles", new object[] {}, "DESKTOP_MEDIA_UNAVAILABLE", 2000);
    if (op == "capture")
      return CaptureWindow(p);
    if (op == "release")
    {
      Release();
      return new
      {
        released = true
      };
    }

    if (op == "wait")
    {
      int duration = Math.Max(100, Math.Min(3000, N(p, "timeoutMs", 500)));
      for (int elapsed = 0; elapsed < duration; elapsed += 50)
      {
        Check();
        Thread.Sleep(50);
      }

      return new
      {
        dispatched = false,
        method = "wait"
      };
    }

    if (op == "activate")
    {
      IntPtr hwnd = Target(p);
      Check();
      return Activate(hwnd);
    }

    // 观察与执行前把目标切到前台；不因用户输入中断（只读分类），失败时给出 DESKTOP_FOCUS_DENIED。
    if (op == "focus")
      return Activate(Target(p));
    if (op == "state")
      return State(Target(p));
    if (op == "windowAt")
      return WindowAt(p);
    if (op == "findText")
      return FindText(p);

    if (op == "element")
      return ElementAction(p);
    if (!Listening)
      throw new Exception("DESKTOP_INPUT_MONITOR_UNAVAILABLE: 无法监听用户接管，已停止自动输入");
    if (op == "media")
      return Media(p);
    IntPtr target = Target(p);
    object observed = null;
    InputWindow = target;
    if (GetForegroundWindow() != target)
      throw new Exception("DESKTOP_FOCUS_CHANGED: 前台窗口已变化，请重新观察");
    if (op == "mouse")
    {
      // 痛点 18：点击点下方实际的窗口必须属于目标程序，移动鼠标之前核对，不是就不发出任何输入。
      if (action != "mouse_up" && action != "move")
        EnsurePointOwner(target, N(p, "x"), N(p, "y"));
      if (action == "drag")
        EnsurePointOwner(target, N(p, "x2"), N(p, "y2"), (uint)Math.Max(0, N(p, "dropPid")));
      if (action != "mouse_up")
        Move(N(p, "x"), N(p, "y"));
      // 左键 2/4、右键 8/16、中键 0x20/0x40（按下/松开）。
      uint down = ButtonDown(S(p, "button", "left"), action), up = down * 2;
      if (action == "move")
        return new
        {
          dispatched = true
        };
      if (action == "mouse_up")
      {
        lock (InputLock)
        {
          if (HeldButtons.Contains(up))
          {
            Mouse(up, 0, 0, 0, true);
            HeldButtons.Remove(up);
          }
        }
      }
      else if (action == "mouse_down")
      {
        lock (InputLock)
        {
          Mouse(down);
          HeldButtons.Add(up);
        }
      }
      else
      {
        // 修饰键加点击（Ctrl+点击、Shift+滚动等）：先按下修饰键，点完一定松开。
        List<ushort> modifiers = ModifierCodes(S(p, "modifiers"));
        try
        {
          foreach (ushort code in modifiers)
            Key(code, false);
          if (action == "scroll")
          {
            int amount = Math.Max(1, Math.Min(20, N(p, "amount", 3)));
            string direction = S(p, "direction", "down");
            Mouse(direction == "left" || direction == "right" ? 0x1000u : 0x800u, 0, 0, unchecked((uint)(120 * amount * (direction == "down" || direction == "left" ? -1 : 1))));
          }
          else
          {
            int count = action == "triple_click" ? 3 : action == "double_click" ? 2 : 1;
            for (int i = 0; i < count; i++)
            {
              lock (InputLock)
              {
                Mouse(down);
                HeldButtons.Add(up);
              }

              try
              {
                if (action == "drag")
                {
                  int x = N(p, "x"), y = N(p, "y");
                  for (int step = 1; step <= 12; step++)
                  {
                    Check();
                    Move(x + (N(p, "x2") - x) * step / 12, y + (N(p, "y2") - y) * step / 12);
                    Thread.Sleep(12);
                  }
                }
              }
              finally
              {
                lock (InputLock)
                {
                  Mouse(up, 0, 0, 0, true);
                  HeldButtons.Remove(up);
                }
              }

              if (count > 1)
                Thread.Sleep(60);
            }
          }
        }
        finally
        {
          for (int m = modifiers.Count - 1; m >= 0; m--)
            if (HeldKeys.Contains(modifiers[m]))
              Key(modifiers[m], true, false, true);
        }
      }
    }
    else if (op == "keyboard")
    {
      if (action == "type")
      {
        foreach (int code in new int[]
        {
          0x10,
          0x11,
          0x12,
          0x5B,
          0x5C
        }

        )
          if ((GetAsyncKeyState(code) & 0x8000) != 0 && !HeldKeys.Contains((ushort)code))
            throw new Exception("DESKTOP_USER_BUSY: 用户仍按住修饰键");
        string typedBefore = FocusedValue(target);
        foreach (char ch in S(p, "text"))
        {
          Check();
          if (GetForegroundWindow() != target)
            throw new Exception("DESKTOP_FOCUS_CHANGED: 输入焦点已变化");
          Key(ch, false, true);
          Key(ch, true, true, true);
        }

        observed = TypedReadBack(target, S(p, "text"), typedBefore);
      }
      else
      {
        string[] keys = SplitKeys(S(p, "text"));
        List<ushort> codes = new List<ushort>();
        foreach (string key in keys)
          codes.Add(KeyCode(key));
        if (action == "key_up")
        {
          lock (InputLock)
          {
            foreach (ushort code in codes)
              if (HeldKeys.Contains(code))
                Key(code, true, false, true);
          }
        }
        else if (action == "key_down")
          foreach (ushort code in codes)
            Key(code, false);
        else
          try
          {
            foreach (ushort code in codes)
              Key(code, false);
          }
          finally
          {
            for (int i = codes.Count - 1; i >= 0; i--)
              if (HeldKeys.Contains(codes[i]))
                Key(codes[i], true, false, true);
          }
      }
    }
    else
      throw new Exception("DESKTOP_ACTION_UNSUPPORTED: 未知桌面操作");
    if (action == "mouse_down" || action == "key_down")
    {
      if (HoldTimer != null)
        HoldTimer.Dispose();
      HoldTimer = new Timer(_ => Release(), null, 2000, Timeout.Infinite);
    }

    Check();
    return new
    {
      dispatched = true,
      method = "native",
      observed = observed
    };
  }

  public static void Run()
  {
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.InputEncoding = new UTF8Encoding(false);
    Thread hooks = new Thread(() =>
    {
      HookThread = GetCurrentThreadId();
      IntPtr module = GetModuleHandle(null);
      MouseHandle = SetWindowsHookEx(14, MouseProc, module, 0);
      KeyHandle = SetWindowsHookEx(13, KeyProc, module, 0);
      Listening = MouseHandle != IntPtr.Zero && KeyHandle != IntPtr.Zero;
      LastInput input = new LastInput
      {
        size = (uint)Marshal.SizeOf(typeof(LastInput))
      };
      GetLastInputInfo(ref input);
      Write(new { ready = true, monitor = Listening, idleMs = unchecked((uint)Environment.TickCount - input.time) });
      Message message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
      {
      }

      UnhookWindowsHookEx(MouseHandle);
      UnhookWindowsHookEx(KeyHandle);
    });
    hooks.IsBackground = true;
    hooks.Start();
    Thread executor = new Thread(() =>
    {
      try
      {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
      }
      catch (EntryPointNotFoundException)
      {
      }

      foreach (Dictionary<string, object> request in Requests.GetConsumingEnumerable())
      {
        string id = S(request, "id");
        string requested = S(request, "operation");
        ActiveReadOnly = requested == "perception" || requested == "mediaTitles" || requested == "windows" || requested == "active" || requested == "window" || requested == "position" || requested == "observe" || requested == "focus" || requested == "state" || requested == "ocr" || requested == "capture" || requested == "windowAt" || requested == "findText";
        ActiveId = id;
        ActionDispatched = false;
        try
        {
          Write(new { id = id, ok = true, result = Execute(request) });
        }
        catch (Exception error)
        {
          Release();
          Write(new { id = id, ok = false, error = error.Message, dispatched = ActionDispatched });
        }
        finally
        {
          ActiveId = "";
          ActiveReadOnly = false;
          InputWindow = IntPtr.Zero;
          bool ignored;
          Cancelled.TryRemove(id, out ignored);
          Known.TryRemove(id, out ignored);
        }
      }

      Release();
    });
    executor.SetApartmentState(ApartmentState.STA);
    executor.IsBackground = true;
    executor.Start();
    string line;
    while ((line = Console.ReadLine()) != null)
    {
      try
      {
        var request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
        if (S(request, "operation") == "cancel")
        {
          string targetId = S(request, "targetId");
          if (Known.ContainsKey(targetId))
          {
            Cancelled[targetId] = true;
            if (targetId == ActiveId)
              Release();
          }

          continue;
        }

        Known[S(request, "id")] = true;
        Requests.Add(request);
      }
      catch (Exception error)
      {
        Write(new { error = "DESKTOP_PROTOCOL_ERROR: " + error.Message });
      }
    }

    Requests.CompleteAdding();
    executor.Join(2000);
    PostThreadMessage(HookThread, 0x12, UIntPtr.Zero, IntPtr.Zero);
  }
}
`

/** Windows 桥接源码随主进程打包；仅在首次桌面操作时由系统 PowerShell 加载。 */
export const WINDOWS_DESKTOP_SOURCE =
  MAIN_SOURCE +
  WINDOWS_DESKTOP_UIA_PART +
  WINDOWS_DESKTOP_HANDS_PART +
  WINDOWS_DESKTOP_VISION_PART +
  WINDOWS_DESKTOP_CAPTURE_PART +
  WINDOWS_PERCEPTION_PART +
  WINDOWS_DESKTOP_WINDOW_STATE_PART
