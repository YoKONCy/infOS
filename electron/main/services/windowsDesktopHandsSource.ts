/**
 * @file 桥接的「手」（C# partial，与 windowsDesktopSource.ts 拼成同一份源码）。
 *
 * - `windowAt`（只读）：点击点下方实际的顶层窗口（WindowFromPoint → GetAncestor(GA_ROOT)），
 *   另附点击点下方控件的名字与 AutomationId（UIA ElementFromPoint），交给护栏判断是不是发送、付款按钮。
 * - 点击、拖动、滚动发出前核对点击点下方的窗口属于目标程序（同一进程）；不是就不发出任何输入，
 *   报 `DESKTOP_POINT_OTHER_WINDOW` 并说明挡在上面的是谁（痛点 18：按点击点下方实际的窗口判断分区）。
 * - 回读：控件操作前后各读一次控件状态（值、勾选、展开、选中），写值时另读完整值直接比较（valueMatches）；
 *   输入文字前后各读一次焦点控件的值，比较这段字出现的次数有没有增加（added）；
 *   结果放在回执里，由 desktopVerify.ts 判断做成了没有。读不到（密码框、控件已消失）就不给。
 * - `findText`（只读）：在目标窗口的控件树里找一段文字（名字、当前值、文档正文开头），供 wait_for 轮询；
 *   不登记控件引用（不会让本次观察的 elementId 失效），节点数与耗时有上限。
 * - 按键补全（痛点 13）：标点（; = , - . / ` [ \ ] '）、小键盘、媒体与音量键、CapsLock 等；
 *   `Ctrl++` 这种以加号结尾的组合；中键（button: middle）、三击（triple_click）、修饰键加点击（modifiers）。
 *   虚拟键码取自 Windows 文档《Virtual-Key Codes》。
 * - `media`：直通通道的媒体键（播放暂停、上下一首、停止、音量），发给系统，不需要目标窗口。
 *
 * @platform WINDOWS
 */
export const WINDOWS_DESKTOP_HANDS_PART = String.raw`
public static partial class InfOSDesktop
{
  [DllImport("user32.dll")]
  static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

  // 点击点下方实际的顶层窗口（GA_ROOT = 2）；点不到任何窗口时为 IntPtr.Zero。
  static IntPtr RootAt(int x, int y)
  {
    Point point = new Point { x = x, y = y };
    IntPtr hwnd = WindowFromPoint(point);
    return hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, 2);
  }

  static object WindowAt(Dictionary<string, object> p)
  {
    IntPtr root = RootAt(N(p, "x"), N(p, "y"));
    return new { window = root == IntPtr.Zero ? null : Window(root), element = PointElement(N(p, "x"), N(p, "y")) };
  }

  // 点击点下方的控件（UIA ElementFromPoint）：名字与 AutomationId 交给护栏判断是不是发送、付款按钮。
  // 文字、图片这类叶子节点再往上看两层，取到外层按钮的名字。读不到返回 null（护栏按「认不出」处理）。
  static object PointElement(int x, int y)
  {
    try
    {
      AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
      List<string> labels = new List<string>();
      for (int depth = 0; e != null && depth < 3; depth++)
      {
        ControlType type = e.Current.ControlType;
        if (type == ControlType.Window || type == ControlType.Pane || type == ControlType.Document)
          break;
        string name = Clip(e.Current.Name, 120);
        string id = Clip(e.Current.AutomationId, 120);
        if (name != "")
          labels.Add(name);
        if (id != "")
          labels.Add(id);
        if (type != ControlType.Text && type != ControlType.Image && type != ControlType.Custom && type != ControlType.Group)
          break;
        e = TreeWalker.ControlViewWalker.GetParent(e);
      }

      return new { labels = labels };
    }
    catch
    {
      return null;
    }
  }

  // 点击点下方必须是目标程序（同一进程）的窗口；否则不发出任何输入。
  // allowedPid 不为 0 时（跨程序拖动的终点，主进程已核对并经护栏批准）改为核对这个进程。
  static void EnsurePointOwner(IntPtr target, int x, int y, uint allowedPid = 0)
  {
    IntPtr root = RootAt(x, y);
    uint want, got = 0;
    GetWindowThreadProcessId(target, out want);
    if (allowedPid != 0)
      want = allowedPid;
    if (root != IntPtr.Zero)
      GetWindowThreadProcessId(root, out got);
    if (root != IntPtr.Zero && got == want)
      return;
    string name = "", title = "";
    if (root != IntPtr.Zero)
    {
      StringBuilder text = new StringBuilder(256);
      GetWindowText(root, text, text.Capacity);
      title = text.ToString();
      try
      {
        using (Process process = Process.GetProcessById((int)got))
          name = process.ProcessName;
      }
      catch
      {
      }
    }

    throw new Exception("DESKTOP_POINT_OTHER_WINDOW: 点击点下方是另一个程序的窗口（" + name + "「" + Clip(title, 60) + "」，windowId " + root.ToInt64().ToString() + "），没有发出输入。要操作它请传这个 windowId 重新观察；否则换一个没被挡住的位置。");
  }

  // 控件当前状态：值（密码框不读）、勾选、展开、选中。读失败返回 null。
  static Dictionary<string, object> ElementState(AutomationElement e)
  {
    try
    {
      object pattern;
      Dictionary<string, object> state = new Dictionary<string, object>();
      if (!e.Current.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        state["value"] = Clip(((ValuePattern)pattern).Current.Value, 200);
      if (e.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
        state["toggle"] = ((TogglePattern)pattern).Current.ToggleState.ToString();
      if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
        state["expand"] = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString();
      if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
        state["selected"] = ((SelectionItemPattern)pattern).Current.IsSelected;
      return state;
    }
    catch
    {
      return null;
    }
  }

  // 动作后稍等再读，界面来得及更新。
  static Dictionary<string, object> StateAfter(AutomationElement e)
  {
    Thread.Sleep(80);
    return ElementState(e);
  }

  // 写值后的状态：另读完整的值直接比较（回执里的 value 只是 200 字预览），长文字也能核对。
  static Dictionary<string, object> ValueAfter(AutomationElement e, string text)
  {
    Dictionary<string, object> after = StateAfter(e);
    try
    {
      object current;
      if (after != null && e.TryGetCurrentPattern(ValuePattern.Pattern, out current))
        after["valueMatches"] = (((ValuePattern)current).Current.Value ?? "") == text;
    }
    catch
    {
    }

    return after;
  }

  // 输入前读焦点控件的值（读不到返回 null）：回读时比较这段字出现的次数，原来就有不算做成。
  static string FocusedValue(IntPtr target)
  {
    try
    {
      AutomationElement focused = AutomationElement.FocusedElement;
      if (focused == null || focused.Current.IsPassword)
        return null;
      uint pid;
      GetWindowThreadProcessId(target, out pid);
      if (focused.Current.ProcessId != (int)pid)
        return null;
      object pattern;
      if (!focused.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        return null;
      return (((ValuePattern)pattern).Current.Value ?? "").Replace(((char)13).ToString(), "").Replace(((char)10).ToString(), "");
    }
    catch
    {
      return null;
    }
  }

  static int Occurrences(string value, string part)
  {
    if (string.IsNullOrEmpty(part))
      return 0;
    int count = 0;
    for (int index = value.IndexOf(part, StringComparison.Ordinal); index >= 0; index = value.IndexOf(part, index + part.Length, StringComparison.Ordinal))
      count++;
    return count;
  }

  // 输入后读焦点控件：是不是目标程序、能不能读、值里有没有刚输入的字（忽略换行）；
  // before 是输入前的值（读不到为 null），据此给出 added：这段字的出现次数有没有增加。
  static object TypedReadBack(IntPtr target, string text, string before)
  {
    try
    {
      Thread.Sleep(80);
      AutomationElement focused = AutomationElement.FocusedElement;
      if (focused == null)
        return null;
      uint pid;
      GetWindowThreadProcessId(target, out pid);
      if (focused.Current.ProcessId != (int)pid)
        return new { otherProgram = true };
      string role = focused.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
      if (focused.Current.IsPassword)
        return new { role = role, password = true };
      object pattern;
      if (!focused.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        return new { role = role, readable = false };
      string value = (((ValuePattern)pattern).Current.Value ?? "").Replace(((char)13).ToString(), "").Replace(((char)10).ToString(), "");
      string typed = (text ?? "").Replace(((char)13).ToString(), "").Replace(((char)10).ToString(), "");
      if (before == null)
        return new { role = role, readable = true, contains = value.Contains(typed) };
      return new { role = role, readable = true, contains = value.Contains(typed), added = Occurrences(value, typed) > Occurrences(before, typed) };
    }
    catch
    {
      return null;
    }
  }

  static object FindText(Dictionary<string, object> p)
  {
    IntPtr hwnd = Target(p);
    string want = S(p, "text").Trim();
    if (want == "")
      throw new Exception("DESKTOP_TEXT_REQUIRED: 请提供要找的文字");
    WakeChromium(hwnd);
    CacheRequest cache = ObserveCache();
    TreeWalker walker = TreeWalker.ControlViewWalker;
    Queue<AutomationElement> nodes = new Queue<AutomationElement>();
    nodes.Enqueue(AutomationElement.FromHandle(hwnd).GetUpdatedCache(cache));
    Stopwatch clock = Stopwatch.StartNew();
    int visited = 0, documents = 0;
    bool truncated = false;
    while (nodes.Count > 0)
    {
      if (visited >= 4000 || clock.ElapsedMilliseconds > 2500)
      {
        truncated = true;
        break;
      }

      visited++;
      AutomationElement e = nodes.Dequeue();
      try
      {
        if (!Flag(e, AutomationElement.IsOffscreenProperty))
        {
          string name = e.GetCachedPropertyValue(AutomationElement.NameProperty) as string ?? "";
          string value = Flag(e, AutomationElement.IsPasswordProperty) ? "" : e.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string ?? "";
          string text = name + " " + value;
          ControlType type = (ControlType)e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
          if (type == ControlType.Document && Flag(e, AutomationElement.IsTextPatternAvailableProperty) && documents++ < 3)
            try
            {
              text += " " + ((TextPattern)e.GetCurrentPattern(TextPattern.Pattern)).DocumentRange.GetText(4000);
            }
            catch (Exception)
            {
            }

          if (text.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0)
            return new { found = true, role = type.ProgrammaticName.Replace("ControlType.", ""), text = Clip(name != "" ? name : value, 120), visited = visited, truncated = false };
        }

        AutomationElement child = walker.GetFirstChild(e, cache);
        int siblings = 0;
        while (child != null && siblings++ < 300 && nodes.Count < 4000)
        {
          nodes.Enqueue(child);
          child = walker.GetNextSibling(child, cache);
        }
      }
      catch (ElementNotAvailableException)
      {
      }
    }

    return new { found = false, visited = visited, truncated = truncated };
  }

  // 鼠标键：left / right / middle；right_click 一律右键。返回按下的标志，松开 = 按下 × 2。
  static uint ButtonDown(string button, string action)
  {
    if (action == "right_click" || button == "right")
      return 8u;
    if (button == "middle")
      return 0x20u;
    if (button != "left" && button != "")
      throw new Exception("DESKTOP_BUTTON_INVALID: 鼠标键只能是 left、right、middle");
    return 2u;
  }

  // 修饰键加点击只收 ctrl / alt / shift（不收 Win，避免触发系统快捷键）。
  static List<ushort> ModifierCodes(string value)
  {
    List<ushort> codes = new List<ushort>();
    if (value.Trim() == "")
      return codes;
    foreach (string part in value.Split('+'))
    {
      string key = part.Trim().ToUpperInvariant();
      ushort code = key == "CTRL" || key == "CONTROL" ? (ushort)0x11 : key == "ALT" ? (ushort)0x12 : key == "SHIFT" ? (ushort)0x10 : (ushort)0;
      if (code == 0)
        throw new Exception("DESKTOP_HOTKEY_INVALID: 修饰键只能是 ctrl、alt、shift");
      if (!codes.Contains(code))
        codes.Add(code);
    }

    return codes;
  }

  // 拆组合键：Ctrl++、Ctrl+Shift++ 末尾的加号是「加号键」。
  static string[] SplitKeys(string text)
  {
    string value = text.Trim();
    if (value == "+")
      return new string[] { "PLUS" };
    if (value.EndsWith("++"))
    {
      List<string> keys = new List<string>(value.Substring(0, value.Length - 2).Split('+'));
      keys.Add("PLUS");
      return keys.ToArray();
    }

    return value.Split('+');
  }

  static bool IsExtendedKey(ushort code)
  {
    switch (code)
    {
      case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2C: case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0x90:
      case 0xA3: case 0xA5:
      case 0xAD: case 0xAE: case 0xAF: case 0xB0: case 0xB1: case 0xB2: case 0xB3:
        return true;
      default:
        return false;
    }
  }

  // 主表（KeyCode）之外的按键：标点、小键盘、媒体与音量键、锁定键等。
  static ushort ExtraKeyCode(string key, string original)
  {
    string single = original.Trim();
    if (single.Length == 1)
    {
      switch (single[0])
      {
        case ';': return 0xBA;
        case '=': return 0xBB;
        case ',': return 0xBC;
        case '-': return 0xBD;
        case '.': return 0xBE;
        case '/': return 0xBF;
        case (char)96: return 0xC0; // 反引号
        case '[': return 0xDB;
        case (char)92: return 0xDC; // 反斜杠
        case ']': return 0xDD;
        case (char)39: return 0xDE; // 单引号
      }
    }

    int number;
    foreach (string prefix in new string[] { "NUMPAD", "NUM" })
      if (key.StartsWith(prefix) && int.TryParse(key.Substring(prefix.Length), out number) && number >= 0 && number <= 9)
        return (ushort)(0x60 + number);
    switch (key)
    {
      case "SEMICOLON": return 0xBA;
      case "EQUAL": case "EQUALS": case "PLUS": return 0xBB;
      case "COMMA": return 0xBC;
      case "MINUS": return 0xBD;
      case "PERIOD": case "DOT": return 0xBE;
      case "SLASH": return 0xBF;
      case "BACKQUOTE": case "BACKTICK": case "GRAVE": return 0xC0;
      case "BRACKETLEFT": case "LEFTBRACKET": return 0xDB;
      case "BACKSLASH": return 0xDC;
      case "BRACKETRIGHT": case "RIGHTBRACKET": return 0xDD;
      case "QUOTE": case "APOSTROPHE": return 0xDE;
      case "NUMPADMULTIPLY": case "MULTIPLY": return 0x6A;
      case "NUMPADADD": case "ADD": return 0x6B;
      case "NUMPADSUBTRACT": case "SUBTRACT": return 0x6D;
      case "NUMPADDECIMAL": case "DECIMAL": return 0x6E;
      case "NUMPADDIVIDE": case "DIVIDE": return 0x6F;
      case "NUMLOCK": return 0x90;
      case "CAPSLOCK": return 0x14;
      case "SCROLLLOCK": return 0x91;
      case "PAUSE": return 0x13;
      case "PRINTSCREEN": case "PRTSC": return 0x2C;
      case "MENU": case "APPS": case "CONTEXTMENU": return 0x5D;
      case "RIGHTCTRL": case "RIGHTCONTROL": return 0xA3;
      case "RIGHTALT": return 0xA5;
      case "RIGHTSHIFT": return 0xA1;
      case "RIGHTWIN": case "RIGHTSUPER": return 0x5C;
      case "VOLUMEMUTE": case "MUTE": return 0xAD;
      case "VOLUMEDOWN": return 0xAE;
      case "VOLUMEUP": return 0xAF;
      case "MEDIANEXT": case "NEXTTRACK": return 0xB0;
      case "MEDIAPREV": case "MEDIAPREVIOUS": case "PREVTRACK": return 0xB1;
      case "MEDIASTOP": return 0xB2;
      case "MEDIAPLAYPAUSE": case "PLAYPAUSE": return 0xB3;
      default:
        throw new Exception("DESKTOP_HOTKEY_INVALID: 不支持的按键 " + original);
    }
  }

  // 直通通道：媒体与音量键发给系统，不绑定窗口；只收这几种键。
  static object Media(Dictionary<string, object> p)
  {
    string key = S(p, "key").Trim().ToUpperInvariant();
    if (key != "PLAYPAUSE" && key != "MEDIANEXT" && key != "MEDIAPREV" && key != "MEDIASTOP" && key != "VOLUMEUP" && key != "VOLUMEDOWN" && key != "VOLUMEMUTE")
      throw new Exception("DESKTOP_HOTKEY_INVALID: 不支持的媒体键 " + key);
    ushort code = ExtraKeyCode(key, key);
    int times = Math.Max(1, Math.Min(10, N(p, "times", 1)));
    for (int i = 0; i < times; i++)
    {
      Key(code, false);
      Key(code, true, false, true);
      Thread.Sleep(30);
    }

    return new
    {
      dispatched = true,
      method = "native",
      key = key,
      times = times
    };
  }
}
`