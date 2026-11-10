/**
 * @file 桥接读取界面结构（C# partial，与 windowsDesktopSource.ts 拼成同一份源码）。
 *
 * `observe` 带 includeElements 时广度遍历目标窗口的控件视图：
 * - 可操作控件（invoke / value / toggle / select / scroll / expand）照旧登记引用，另带当前值；
 * - 文字内容（标签、状态栏、表格单元、列表项、文档正文等）也一并返回，不再只有可操作控件；
 * - 用 CacheRequest 一次取回每个节点要用的属性，比逐个属性跨进程读取快得多；
 * - 访问节点数、条数、耗时都有上限，超出时标注 truncated，由 TS 侧说明并按需用 OCR 补上。
 * 控件编号用进程内递增的短编号（e1、e2…），不会在两次观察之间被复用到别的控件上。
 *
 * Chromium/Electron 窗口的页面无障碍树要在有客户端读过页面根节点后才会建立；
 * 唤醒做法移植自 Yu-tao-Li/dsh-computer-use-win `scripts/windows-uia.ps1`（MIT；
 * Copyright (c) 2026 Yu-tao-Li；Copyright (c) 2026 cgissing），见 THIRD_PARTY_NOTICES.md。
 *
 * @platform WINDOWS
 */
export const WINDOWS_DESKTOP_UIA_PART = String.raw`
public static partial class InfOSDesktop
{
  static long ElementCounter;
  static readonly HashSet<long> WokenRenderers = new HashSet<long>();
  [DllImport("user32.dll")]
  static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);

  static string Clip(string value, int length)
  {
    value = (value ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
    return value.Length > length ? value.Substring(0, length) + "…" : value;
  }

  // 读一次页面根节点，让 Chromium 建立页面无障碍树；第一次见到的页面最多等 1 秒。
  static void WakeChromium(IntPtr hwnd)
  {
    List<IntPtr> renderers = new List<IntPtr>();
    StringBuilder name = new StringBuilder(64);
    EnumChildWindows(hwnd, (child, l) =>
    {
      name.Length = 0;
      GetClassName(child, name, name.Capacity);
      if (name.ToString() == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(child))
        renderers.Add(child);
      return renderers.Count < 8;
    }, IntPtr.Zero);
    bool fresh = false;
    foreach (IntPtr renderer in renderers)
    {
      fresh |= WokenRenderers.Add(renderer.ToInt64());
      try
      {
        AutomationElement root = TreeWalker.RawViewWalker.GetFirstChild(AutomationElement.FromHandle(renderer));
        if (root != null)
        {
          object ignored = root.Current.ControlType;
        }
      }
      catch (Exception)
      {
      }
    }

    if (!fresh)
      return;
    for (int waited = 0; waited < 1000; waited += 100)
    {
      Check();
      bool ready = true;
      foreach (IntPtr renderer in renderers)
        try
        {
          AutomationElement root = TreeWalker.RawViewWalker.GetFirstChild(AutomationElement.FromHandle(renderer));
          ready &= root != null && TreeWalker.RawViewWalker.GetFirstChild(root) != null;
        }
        catch (Exception)
        {
        }

      if (ready)
        return;
      Thread.Sleep(100);
    }
  }

  static CacheRequest ObserveCache()
  {
    CacheRequest cache = new CacheRequest();
    cache.TreeFilter = Automation.ControlViewCondition;
    cache.AutomationElementMode = AutomationElementMode.Full;
    foreach (AutomationProperty property in new AutomationProperty[] {
      AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty,
      AutomationElement.IsOffscreenProperty, AutomationElement.IsEnabledProperty, AutomationElement.IsPasswordProperty,
      AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
      AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
      AutomationElement.IsScrollPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
      AutomationElement.IsTextPatternAvailableProperty, ValuePattern.ValueProperty, AutomationElement.AutomationIdProperty })
      cache.Add(property);
    return cache;
  }

  static bool Flag(AutomationElement e, AutomationProperty property)
  {
    object value = e.GetCachedPropertyValue(property, true);
    return value is bool && (bool)value;
  }

  static object Observe(Dictionary<string, object> p)
  {
    IntPtr hwnd = Target(p);
    List<object> items = new List<object>();
    List<object> texts = new List<object>();
    bool truncated = false;
    int visited = 0;
    if (S(p, "includeElements") == "True" || S(p, "includeElements") == "true")
    {
      Elements.Clear();
      WakeChromium(hwnd);
      int limit = Math.Max(1, Math.Min(150, N(p, "limit", 100)));
      int textLimit = Math.Max(0, Math.Min(600, N(p, "textLimit", 300)));
      int documents = 0;
      Stopwatch clock = Stopwatch.StartNew();
      CacheRequest cache = ObserveCache();
      TreeWalker walker = TreeWalker.ControlViewWalker;
      Queue<AutomationElement> nodes = new Queue<AutomationElement>();
      nodes.Enqueue(AutomationElement.FromHandle(hwnd).GetUpdatedCache(cache));
      while (nodes.Count > 0)
      {
        if (visited >= 3000 || clock.ElapsedMilliseconds > 4000 || (items.Count >= limit && texts.Count >= textLimit))
        {
          truncated = true;
          break;
        }

        visited++;
        Check();
        AutomationElement e = nodes.Dequeue();
        try
        {
          ControlType type = (ControlType)e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
          System.Windows.Rect r = (System.Windows.Rect)e.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
          if (!Flag(e, AutomationElement.IsOffscreenProperty) && !r.IsEmpty && type != ControlType.Window && type != ControlType.Pane)
          {
            string role = type.ProgrammaticName.Replace("ControlType.", "");
            string name = e.GetCachedPropertyValue(AutomationElement.NameProperty) as string ?? "";
            bool password = Flag(e, AutomationElement.IsPasswordProperty);
            string value = password ? "" : e.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string ?? "";
            object bounds = new { x = r.X, y = r.Y, width = r.Width, height = r.Height };
            List<string> patterns = new List<string>();
            if (Flag(e, AutomationElement.IsInvokePatternAvailableProperty))
              patterns.Add("invoke");
            if (Flag(e, AutomationElement.IsValuePatternAvailableProperty) && !password)
              patterns.Add("value");
            if (Flag(e, AutomationElement.IsTogglePatternAvailableProperty))
              patterns.Add("toggle");
            if (Flag(e, AutomationElement.IsSelectionItemPatternAvailableProperty))
              patterns.Add("select");
            if (Flag(e, AutomationElement.IsScrollPatternAvailableProperty))
              patterns.Add("scroll");
            if (Flag(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))
              patterns.Add("expand");
            if (patterns.Count > 0 && items.Count < limit)
            {
              string id = "e" + (++ElementCounter).ToString();
              Elements[id] = e;
              string automationId = e.GetCachedPropertyValue(AutomationElement.AutomationIdProperty, true) as string ?? "";
              items.Add(new { id = id, name = Clip(name, 120), role = role, enabled = Flag(e, AutomationElement.IsEnabledProperty), patterns = patterns, bounds = bounds, value = Clip(value, 200), automationId = Clip(automationId, 120) });
            }
            else if (patterns.Count == 0 && texts.Count < textLimit)
            {
              // 文档正文：取前 2000 字（只读前 3 个文档，避免大文档拖慢观察）。
              string text = name;
              if (type == ControlType.Document && Flag(e, AutomationElement.IsTextPatternAvailableProperty) && documents++ < 3)
                try
                {
                  text = ((TextPattern)e.GetCurrentPattern(TextPattern.Pattern)).DocumentRange.GetText(2000);
                }
                catch (Exception)
                {
                }

              if (value != "" && value != name)
                text = text == "" ? value : text + " = " + value;
              text = Clip(text, type == ControlType.Document ? 2000 : 300);
              if (text != "")
                texts.Add(new { role = role, text = text, bounds = bounds });
            }
          }

          AutomationElement child = walker.GetFirstChild(e, cache);
          int siblings = 0;
          while (child != null && siblings++ < 200 && nodes.Count < 3000)
          {
            nodes.Enqueue(child);
            child = walker.GetNextSibling(child, cache);
          }
        }
        catch (ElementNotAvailableException)
        {
        }
      }
    }

    return new
    {
      window = Window(hwnd),
      elements = items,
      texts = texts,
      truncated = truncated,
      visited = visited,
      state = State(hwnd)
    };
  }
}
`
