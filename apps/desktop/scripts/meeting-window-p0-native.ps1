# Private read-only observer for the synthetic fixture; launched by Electron.
$ErrorActionPreference = 'Stop'
$target = ConvertFrom-Json -InputObject ([Console]::ReadLine())

Add-Type -ReferencedAssemblies System,System.Core,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class MeetingWindowP0Native
{
    [StructLayout(LayoutKind.Sequential)]
    struct Rect {
        public int Left, Top, Right, Bottom;
        public object Box() {
            return new { x = Left, y = Top, width = (long)Right - Left, height = (long)Bottom - Top };
        }
        public bool Valid { get { return Right > Left && Bottom > Top; } }
    }

    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created,
        out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    static IntPtr Handle(string value) {
        ulong bits;
        if (value == null || !Regex.IsMatch(value, @"\A[1-9][0-9]*\z") ||
            !ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out bits) ||
            (IntPtr.Size == 4 && bits > uint.MaxValue)) throw new ArgumentException("Invalid own HWND");
        return IntPtr.Size == 8 ? new IntPtr(unchecked((long)bits)) : new IntPtr(unchecked((int)bits));
    }

    public static void Run(string decimalHwnd, uint pid, string title, uint overlayPid)
    {
        ulong bits;
        if (!Regex.IsMatch(decimalHwnd, @"\A[1-9][0-9]*\z") ||
            !ulong.TryParse(decimalHwnd, NumberStyles.None, CultureInfo.InvariantCulture, out bits) ||
            (IntPtr.Size == 4 && bits > uint.MaxValue) || pid == 0 ||
            !Regex.IsMatch(title, @"\AMeeting Window P0 [a-f0-9]{32}\z"))
            throw new ArgumentException("Invalid fixture target");

        IntPtr hwnd = IntPtr.Size == 8 ? new IntPtr(unchecked((long)bits)) : new IntPtr(unchecked((int)bits));
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        // Hold a handle to this particular process lifetime; PID alone can be reused.
        IntPtr process = OpenProcess(0x101000 /* SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        try {
            long created, exited, kernel, user;
            string processCreated = process != IntPtr.Zero && GetProcessTimes(process, out created, out exited, out kernel, out user)
                ? created.ToString(CultureInfo.InvariantCulture) : null;
            // One response per request. EOF ends the observer if its launcher exits.
            string request;
            while ((request = Console.ReadLine()) != null) {
                object sample = previous == IntPtr.Zero ? Unavailable("dpi-context") :
                    processCreated == null ? Unavailable("process-identity") :
                    Sample(hwnd, decimalHwnd, pid, title, process, processCreated, overlayPid, request);
                Console.WriteLine(Json.Serialize(sample));
                Console.Out.Flush();
            }
        } finally {
            if (process != IntPtr.Zero) CloseHandle(process);
            if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
        }
    }

    static bool MatchesWindow(IntPtr hwnd, uint expectedPid, string title)
    {
        uint pid;
        if (GetWindowThreadProcessId(hwnd, out pid) == 0 || pid != expectedPid) return false;
        var text = new StringBuilder(title.Length + 2); // avoid matching a truncated prefix
        return GetWindowText(hwnd, text, text.Capacity) == title.Length && text.ToString() == title;
    }

    static bool MatchesFixture(IntPtr hwnd, uint expectedPid, string title, IntPtr process) {
        return WaitForSingleObject(process, 0) == 258 /* WAIT_TIMEOUT */ && MatchesWindow(hwnd, expectedPid, title);
    }

    static string State(IntPtr hwnd) {
        return IsIconic(hwnd) ? "minimized" : IsZoomed(hwnd) ? "maximized" : "normal";
    }

    static object Sample(IntPtr hwnd, string decimalHwnd, uint pid, string title, IntPtr process, string processCreated,
        uint overlayPid, string request)
    {
        if (!MatchesFixture(hwnd, pid, title, process)) return Unavailable("window-identity");
        uint dpi = GetDpiForWindow(hwnd);
        string state = State(hwnd);
        object outerPx = null, dwmPx = null;
        if (state != "minimized") {
            Rect outer, dwm;
            if (!GetWindowRect(hwnd, out outer) || !outer.Valid ||
                DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out dwm, Marshal.SizeOf(typeof(Rect))) != 0 ||
                !dwm.Valid) return Unavailable("geometry");
            outerPx = outer.Box();
            dwmPx = dwm.Box();
        }
        if (!MatchesFixture(hwnd, pid, title, process)) return Unavailable("window-identity");
        if (dpi == 0 || dpi != GetDpiForWindow(hwnd) || state != State(hwnd)) return Unavailable("geometry");
        if (overlayPid != 0) {
            // Read-only overlay evidence. No enumeration, hit-testing, input injection or window mutation.
            Rect client;
            Point location = new Point();
            if (!GetClientRect(hwnd, out client) || !client.Valid || !ClientToScreen(hwnd, ref location)) return Unavailable("geometry");
            object clientPx = new { x = location.X, y = location.Y, width = client.Right - client.Left, height = client.Bottom - client.Top };
            object borderPx = new { x = GetSystemMetricsForDpi(32 /* SM_CXSIZEFRAME */, dpi) + GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, dpi),
                y = GetSystemMetricsForDpi(33 /* SM_CYSIZEFRAME */, dpi) + GetSystemMetricsForDpi(92, dpi) };
            var command = Json.Deserialize<LayerRequest>(request);
            if (command == null || command.layers == null || (command.layers.Length != 0 && command.layers.Length != 5)) return Unavailable("layer-identity");
            string[] roles = { "ink", "top", "bottom", "left", "right" };
            var layers = new List<object>();
            var seen = new HashSet<IntPtr>();
            IntPtr below = hwnd;
            for (int i = 0; i < command.layers.Length; i++) {
                Layer layer = command.layers[i];
                if (layer == null || layer.role != roles[i] || layer.title != title + " Overlay " + roles[i]) return Unavailable("layer-identity");
                IntPtr own = Handle(layer.hwnd);
                if (own == hwnd || !seen.Add(own) || !MatchesWindow(own, overlayPid, layer.title)) return Unavailable("layer-identity");
                Rect bounds;
                if (!GetWindowRect(own, out bounds) || !bounds.Valid) return Unavailable("geometry");
                uint layerDpi = GetDpiForWindow(own);
                bool topmost = (GetWindowLong(own, -20 /* GWL_EXSTYLE */) & 8 /* WS_EX_TOPMOST */) != 0;
                bool visible = IsWindowVisible(own);
                // Exact immediate sibling is intentionally conservative: unknown intervening HWNDs fail closed.
                bool adjacent = GetWindow(own, 2 /* GW_HWNDNEXT */) == below;
                if (!MatchesWindow(own, overlayPid, layer.title)) return Unavailable("layer-identity");
                layers.Add(new { layer.role, layer.hwnd, dpi = layerDpi, outerPx = bounds.Box(), visible, topmost, adjacent });
                below = own;
            }
            if (!MatchesFixture(hwnd, pid, title, process) || dpi != GetDpiForWindow(hwnd) || state != State(hwnd)) return Unavailable("geometry");
            return new { status = "available", hwnd = decimalHwnd, pid, processCreated, state, dpi, outerPx, dwmPx,
                overlay = new { clientPx, borderPx, layers } };
        }
        return new { status = "available", hwnd = decimalHwnd, pid, processCreated, state, dpi, outerPx, dwmPx };
    }

    public sealed class Layer { public string role { get; set; } public string hwnd { get; set; } public string title { get; set; } }
    public sealed class LayerRequest { public Layer[] layers { get; set; } }

    static object Unavailable(string reason) { return new { status = "unavailable", reason }; }
}
'@

[MeetingWindowP0Native]::Run($target.hwnd, $target.pid, $target.title, [uint32]$target.overlayPid)
