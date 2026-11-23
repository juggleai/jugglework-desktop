# Windows PowerShell 5.1, interactive Windows 10 (1703+) or Windows 11.
param([switch]$Probe)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or
    [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'Run with Windows PowerShell 5.1: powershell.exe -NoProfile -STA -File ...'
}

Add-Type -ReferencedAssemblies System,System.Core,System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class MeetingWindowP0 : Form
{
    [StructLayout(LayoutKind.Sequential)]
    struct Rect {
        public int Left, Top, Right, Bottom;
        public object Box() {
            return new { x = Left, y = Top, width = Right - Left, height = Bottom - Top };
        }
    }
    static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    readonly Timer timer = new Timer { Interval = 100 };
    readonly bool probe;
    string lastGeometry;

    public static void Run(bool probe, string windowsBuild, string processArchitecture)
    {
        // powershell.exe can already own HWNDs. Set the context for this UI thread
        // before creating the fixture, rather than trying to change the host process.
        IntPtr previous = SetThreadDpiAwarenessContext(PerMonitorV2);
        if (previous == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try {
            using (var form = new MeetingWindowP0(probe)) {
                if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(form.Handle), PerMonitorV2))
                    throw new InvalidOperationException("Fixture HWND is not Per-Monitor V2 aware");
                Write(new { type = "fixture", windowsBuild, processArchitecture, dpiAwareness = "per-monitor-v2" });
                Application.Run(form);
            }
        } finally {
            SetThreadDpiAwarenessContext(previous);
        }
    }

    MeetingWindowP0(bool probe)
    {
        this.probe = probe;
        Text = "Meeting Window P0 " + Guid.NewGuid().ToString("N");
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(640, 400);
        BackColor = Color.FromArgb(22, 30, 45);
        ResizeRedraw = true;
        DoubleBuffered = true;
        timer.Tick += delegate { ReportGeometry(); };
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // Only the private child pipe receives the transient identity. Standalone
        // output and the Electron probe's console output omit it.
        if (probe) Write(new { type = "identity", hwnd = Handle.ToInt64().ToString(), title = Text });
        ReportGeometry();
        timer.Start();
    }

    static void Write(object value)
    {
        Console.WriteLine(Json.Serialize(value));
        Console.Out.Flush();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x02E0 /* WM_DPICHANGED */) {
            // Apply the OS-suggested physical rectangle to this fixture only,
            // so crossing monitors attempts to preserve its logical size.
            Rect suggested = (Rect)Marshal.PtrToStructure(m.LParam, typeof(Rect));
            SetWindowPos(m.HWnd, IntPtr.Zero, suggested.Left, suggested.Top,
                suggested.Right - suggested.Left, suggested.Bottom - suggested.Top,
                0x0014 /* SWP_NOZORDER | SWP_NOACTIVATE */);
            Invalidate();
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    void ReportGeometry()
    {
        IntPtr hwnd = Handle;
        string state = IsIconic(hwnd) ? "minimized" : IsZoomed(hwnd) ? "maximized" : "normal";
        Rect outer, dwm;
        bool validOuter = GetWindowRect(hwnd, out outer);
        int result = DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out dwm, Marshal.SizeOf(typeof(Rect)));
        uint dpi = GetDpiForWindow(hwnd);
        // Iconic windows can report sentinel or stale bounds. Don't compare them.
        string line = Json.Serialize(new {
            type = "geometry", state, dpi, scalePercent = dpi * 100.0 / 96,
            outerPx = state != "minimized" && validOuter ? outer.Box() : null,
            dwmPx = state != "minimized" && result == 0 ? dwm.Box() : null,
            dwmHresult = result
        });
        if (line == lastGeometry) return;
        lastGeometry = line;
        Console.WriteLine(line);
        Console.Out.Flush();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        float scale = GetDpiForWindow(Handle) / 96f;
        float w = ClientSize.Width, h = ClientSize.Height;
        float inset = 24 * scale;
        Mark(e.Graphics, w, h, inset, inset, scale, Brushes.Tomato, "TL");
        Mark(e.Graphics, w, h, w - inset, inset, scale, Brushes.Gold, "TR");
        Mark(e.Graphics, w, h, inset, h - inset, scale, Brushes.LimeGreen, "BL");
        Mark(e.Graphics, w, h, w - inset, h - inset, scale, Brushes.DeepSkyBlue, "BR");
        Mark(e.Graphics, w, h, w / 2, h / 2, scale, Brushes.White, "C");
    }

    void Mark(Graphics g, float w, float h, float x, float y, float scale, Brush color, string label)
    {
        float radius = 9 * scale;
        g.FillEllipse(color, x - radius, y - radius, 2 * radius, 2 * radius);
        float textX = x > w / 2 ? x - 28 * scale : x + 12 * scale;
        g.DrawString(label, Font, color, textX, y > h / 2 ? y - 16 * scale : y);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        timer.Stop();
        timer.Dispose();
        Write(new { type = "closed" });
        base.OnFormClosed(e);
    }
}
'@

$version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
[MeetingWindowP0]::Run($Probe.IsPresent, "$($version.CurrentBuildNumber).$($version.UBR)", $env:PROCESSOR_ARCHITECTURE)
