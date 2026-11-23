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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("imm32.dll")] static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hwnd);
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

    public static void Run(string decimalHwnd, uint pid, string title, uint overlayPid, bool passiveInk, bool interactive)
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
                    Sample(hwnd, decimalHwnd, pid, title, process, processCreated, overlayPid, request, passiveInk, interactive);
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

    static bool Reaches(IntPtr from, IntPtr target, uint direction) {
        IntPtr cursor = from;
        for (int i = 0; i < 128; i++) {
            cursor = GetWindow(cursor, direction);
            if (cursor == IntPtr.Zero || cursor == from) return false;
            if (cursor == target) return true;
        }
        return false;
    }

    static object Sample(IntPtr hwnd, string decimalHwnd, uint pid, string title, IntPtr process, string processCreated,
        uint overlayPid, string request, bool passiveInk, bool interactive)
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
            if (passiveInk && (state != "normal" || !IsWindowVisible(hwnd) || (GetWindowLong(hwnd, -20) & 8) != 0))
                return Unavailable("geometry");
            // Read-only overlay evidence. No enumeration, hit-testing, input injection or window mutation.
            Rect client;
            Point location = new Point();
            if (!GetClientRect(hwnd, out client) || !client.Valid || !ClientToScreen(hwnd, ref location)) return Unavailable("geometry");
            object clientPx = new { x = location.X, y = location.Y, width = client.Right - client.Left, height = client.Bottom - client.Top };
            object borderPx = new { x = GetSystemMetricsForDpi(32 /* SM_CXSIZEFRAME */, dpi) + GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, dpi),
                y = GetSystemMetricsForDpi(33 /* SM_CYSIZEFRAME */, dpi) + GetSystemMetricsForDpi(92, dpi) };
            var command = Json.Deserialize<LayerRequest>(request);
            if (command == null || command.layers == null || (command.layers.Length != 0 && command.layers.Length != (passiveInk ? 1 : 5))) return Unavailable("layer-identity");
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
                if (passiveInk) {
                    int exStyle = GetWindowLong(own, -20);
                    if (!interactive && (exStyle & 0x80020) != 0x80020)
                        return Unavailable("layer-identity");
                }
                // Exact immediate sibling is intentionally conservative: unknown intervening HWNDs fail closed.
                IntPtr next = GetWindow(own, 2 /* GW_HWNDNEXT */);
                bool adjacent = next == below;
                string targetRelative = null, nextOwner = null, nextRole = null;
                bool? nextOwnedByTarget = null, nextVisible = null, nextOverlapsInk = null, nextHasArea = null;
                if (passiveInk && !adjacent) {
                    bool targetBelow = Reaches(own, hwnd, 2), targetAbove = Reaches(own, hwnd, 3);
                    targetRelative = targetBelow == targetAbove ? "unknown" : targetBelow ? "below" : "above";
                    uint nextPid = 0;
                    if (next != IntPtr.Zero) GetWindowThreadProcessId(next, out nextPid);
                    nextOwner = next == IntPtr.Zero ? "none" : nextPid == pid ? "target-process" :
                        nextPid == overlayPid ? "ink-process" : nextPid == 0 ? "unknown" : "other";
                    nextRole = nextOwner == "target-process" && next == ImmGetDefaultIMEWnd(hwnd) ? "target-default-ime" : "unknown";
                    // Only inspect the synthetic target process's interleaver in detail.
                    if (nextOwner == "target-process") {
                        IntPtr owner = GetWindow(next, 4 /* GW_OWNER */);
                        bool visibleNeighbor = IsWindowVisible(next);
                        Rect neighbor;
                        bool read = GetWindowRect(next, out neighbor);
                        uint checkedPid;
                        if (GetWindowThreadProcessId(next, out checkedPid) != 0 && checkedPid == pid &&
                            GetWindow(own, 2) == next) {
                            nextOwnedByTarget = owner == hwnd;
                            nextVisible = visibleNeighbor;
                            if (read) {
                                nextHasArea = neighbor.Valid;
                                nextOverlapsInk = neighbor.Valid && neighbor.Left < bounds.Right && neighbor.Right > bounds.Left &&
                                    neighbor.Top < bounds.Bottom && neighbor.Bottom > bounds.Top;
                            }
                            if (nextRole == "unknown") {
                                // Class text stays in this process. A family match is a hint, not identity.
                                var cls = new StringBuilder(256);
                                if (GetClassName(next, cls, cls.Capacity) > 0 && GetWindow(own, 2) == next) {
                                    string value = cls.ToString();
                                    if (value == "IME" || value == "MSCTFIME UI") nextRole = "ime-class";
                                    else if (value.StartsWith("WindowsForms10.", StringComparison.Ordinal)) nextRole = "winforms-class";
                                }
                            }
                        }
                    }
                }
                if (!MatchesWindow(own, overlayPid, layer.title)) return Unavailable("layer-identity");
                string aboveOwner = null, aboveRole = null;
                bool? aboveOverlapsInk = null;
                if (passiveInk) {
                    // Read-only: who is immediately above our own ink, and does it overlap?
                    IntPtr above = GetWindow(own, 3 /* GW_HWNDPREV */);
                    uint abovePid = 0;
                    if (above != IntPtr.Zero) GetWindowThreadProcessId(above, out abovePid);
                    aboveOwner = above == IntPtr.Zero ? "none" : abovePid == pid ? "target-process" :
                        abovePid == overlayPid ? "ink-process" : abovePid == 0 ? "unknown" : "other";
                    Rect aboveRect;
                    if (above != IntPtr.Zero && GetWindowRect(above, out aboveRect)) {
                        aboveOverlapsInk = aboveRect.Valid && aboveRect.Left < bounds.Right && aboveRect.Right > bounds.Left &&
                            aboveRect.Top < bounds.Bottom && aboveRect.Bottom > bounds.Top;
                    }
                    aboveRole = "unknown";
                    if (aboveOwner == "target-process" && above != IntPtr.Zero) {
                        string expected = title + " Occluder";
                        var text = new StringBuilder(expected.Length + 2);
                        if (GetWindowText(above, text, text.Capacity) == expected.Length && text.ToString() == expected)
                            aboveRole = "fixture-occluder";
                    }
                    bool occluderAboveInk = false;
                    int occluderWalk = 0, occluderTitleHits = 0;
                    object occluderPx = null, occluderRaw = null;
                    string occluderTitle = title + " Occluder";
                    IntPtr up = own;
                    for (int k = 0; k < 16; k++) {
                        up = GetWindow(up, 3 /* GW_HWNDPREV */);
                        if (up == IntPtr.Zero) break;
                        occluderWalk++;
                        var upText = new StringBuilder(occluderTitle.Length + 2);
                        if (GetWindowText(up, upText, upText.Capacity) == occluderTitle.Length && upText.ToString() == occluderTitle) {
                            occluderTitleHits++;
                            Rect upRect;
                            bool readUp = GetWindowRect(up, out upRect);
                            var upClass = new StringBuilder(128); GetClassName(up, upClass, upClass.Capacity);
                            occluderRaw = new { l = upRect.Left, t = upRect.Top, r = upRect.Right, b = upRect.Bottom, valid = upRect.Valid, read = readUp, cls = upClass.ToString() };
                            if (readUp && upRect.Valid) occluderPx = upRect.Box();
                            occluderAboveInk = readUp && upRect.Valid && upRect.Left < bounds.Right &&
                                upRect.Right > bounds.Left && upRect.Top < bounds.Bottom && upRect.Bottom > bounds.Top;
                            break;
                        }
                    }
                    layers.Add(new { layer.role, layer.hwnd, dpi = layerDpi, outerPx = bounds.Box(), visible, topmost, adjacent,
                        targetRelative, nextOwner, nextRole, nextOwnedByTarget, nextVisible, nextOverlapsInk, nextHasArea,
                        aboveOwner, aboveRole, aboveOverlapsInk, occluderAboveInk, occluderWalk, occluderTitleHits, occluderPx, occluderRaw });
                    below = own;
                    continue;
                }

                layers.Add(new { layer.role, layer.hwnd, dpi = layerDpi, outerPx = bounds.Box(), visible, topmost, adjacent });
                below = own;
            }
            IntPtr layer0Hwnd = IntPtr.Zero;
            foreach (Layer own in command.layers) { if (own != null) { try { layer0Hwnd = Handle(own.hwnd); } catch {} break; } }
            object strips = null;
            if (command.strips != null) {
                var spec = command.strips;
                if (spec.thickness < 1 || spec.thickness > 32 || spec.handles == null) return Unavailable("strip-identity");
                string[] stripRoles = { "top", "bottom", "left", "right" };
                string[] stripHwnds = { spec.handles.top, spec.handles.bottom, spec.handles.left, spec.handles.right };
                var stripFailures = new List<string>();
                int cx = location.X, cy = location.Y, cw = client.Right - client.Left, ch = client.Bottom - client.Top, t = spec.thickness;
                for (int s = 0; s < stripRoles.Length; s++) {
                    IntPtr strip;
                    try { strip = Handle(stripHwnds[s]); } catch { stripFailures.Add(stripRoles[s] + ":hwnd"); continue; }
                    uint stripPid;
                    if (GetWindowThreadProcessId(strip, out stripPid) == 0 || stripPid != spec.pid) { stripFailures.Add(stripRoles[s] + ":pid"); continue; }
                    int ex = GetWindowLong(strip, -20);
                    bool styleOk = (ex & 0x80000) != 0 && (ex & 8) == 0 && (spec.interactive ? (ex & 0x20) == 0 : (ex & 0x20) != 0);
                    if (!styleOk) { stripFailures.Add(stripRoles[s] + ":style"); continue; }
                    if (!IsWindowVisible(strip)) { stripFailures.Add(stripRoles[s] + ":hidden"); continue; }
                    if (!Reaches(strip, hwnd, 2)) { stripFailures.Add(stripRoles[s] + ":below-target"); continue; }
                    Rect bounds;
                    if (!GetWindowRect(strip, out bounds) || !bounds.Valid) { stripFailures.Add(stripRoles[s] + ":rect"); continue; }
                    int exX = stripRoles[s] == "left" ? cx - t : stripRoles[s] == "right" ? cx + cw : cx;
                    int exY = stripRoles[s] == "top" ? cy - t : stripRoles[s] == "bottom" ? cy + ch : cy;
                    int exW = stripRoles[s] == "left" || stripRoles[s] == "right" ? t : cw;
                    int exH = stripRoles[s] == "top" || stripRoles[s] == "bottom" ? t : ch;
                    if (bounds.Left != exX || bounds.Top != exY || bounds.Right - bounds.Left != exW || bounds.Bottom - bounds.Top != exH)
                        stripFailures.Add(stripRoles[s] + ":geometry");
                    bool overlapsClient = bounds.Left < cx + cw && bounds.Right > cx && bounds.Top < cy + ch && bounds.Bottom > cy;
                    if (overlapsClient) stripFailures.Add(stripRoles[s] + ":client-overlap");
                    Point center = new Point();
                    center.X = (bounds.Left + bounds.Right) / 2; center.Y = (bounds.Top + bounds.Bottom) / 2;
                    IntPtr at = spec.interactive ? WindowFromPoint(center) : strip;
                    if (at != strip) {
                        string above = at == hwnd ? "target-above" : (layer0Hwnd != IntPtr.Zero && at == layer0Hwnd) ? "ink-above" : "other-above";
                        stripFailures.Add(stripRoles[s] + ":" + above);
                    }
                    strips = new { ok = stripFailures.Count == 0, count = stripRoles.Length, failures = stripFailures.ToArray() };
                }
            }            if (!MatchesFixture(hwnd, pid, title, process) || dpi != GetDpiForWindow(hwnd) || state != State(hwnd)) return Unavailable("geometry");
            return new { status = "available", hwnd = decimalHwnd, pid, processCreated, state, dpi, outerPx, dwmPx,
                overlay = new { clientPx, borderPx, layers, strips } };
        }
        return new { status = "available", hwnd = decimalHwnd, pid, processCreated, state, dpi, outerPx, dwmPx };
    }

    public sealed class Layer { public string role { get; set; } public string hwnd { get; set; } public string title { get; set; } }
    public sealed class LayerRequest { public Layer[] layers { get; set; } public StripSet strips { get; set; } }
    public sealed class StripSet { public uint pid { get; set; } public int thickness { get; set; } public bool interactive { get; set; } public StripHandles handles { get; set; } }
    public sealed class StripHandles { public string top { get; set; } public string bottom { get; set; } public string left { get; set; } public string right { get; set; } }

    static object Unavailable(string reason) { return new { status = "unavailable", reason }; }
}
'@

[MeetingWindowP0Native]::Run($target.hwnd, $target.pid, $target.title, [uint32]$target.overlayPid, ($target.passiveInk -eq $true), ($target.interactive -eq $true))
if ($target.passiveInk -eq $true) { [Console]::WriteLine('{"type":"observer-eof"}') }
