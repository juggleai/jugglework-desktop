// Experimental inspector/observer; `activate` requests foreground once after publication.
// Does not move or resize the target, enable annotation, or capture any content.
// Compile on Windows with the .NET Framework C# compiler; no UI or title access.
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class MeetingWindowIdentityWindows
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process, out FileTime created,
        out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr window, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int capacity);
    [DllImport("imm32.dll")] private static extern IntPtr ImmGetDefaultIMEWnd(IntPtr window);
#if FIXTURE_ANCHOR_ROLES
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
    private static IntPtr fixtureToolbar;
    private static string FixtureRole(IntPtr h, IntPtr ink, IntPtr target, uint ownPid)
    {
        if (h == IntPtr.Zero) return "none";
        if (h == ink) return "canvas";
        if (h == fixtureToolbar) return "toolbar";
        if (h == target) return "target";
        uint pid;
        return GetWindowThreadProcessId(h, out pid) == 0 ? "unknown" : pid == ownPid ? "own-other" : "foreign";
    }
    private static void FixtureSnapshot(string stage, IntPtr ink, IntPtr target, uint ownPid, IntPtr anchor, string api)
    {
        IntPtr prev = GetWindow(target, 3);
        Console.Error.WriteLine("{\"stage\":\"" + stage + "\",\"targetPrev\":\"" + FixtureRole(prev, ink, target, ownPid) +
            "\",\"targetPrevVisible\":" + (IsWindowVisible(prev) ? "true" : "false") +
            ",\"targetNext\":\"" + FixtureRole(GetWindow(target, 2), ink, target, ownPid) + "\"" +
            ",\"targetPrevTopmost\":" + ((GetWindowLongW(prev, -20) & 8) != 0 ? "true" : "false") +
            ",\"anchor\":\"" + FixtureRole(anchor, ink, target, ownPid) + "\",\"anchorOwner\":\"" + FixtureRole(GetWindow(anchor, 4), ink, target, ownPid) +
            "\",\"canvasOwner\":\"" + FixtureRole(GetWindow(ink, 4), ink, target, ownPid) +
            "\",\"toolbarOwner\":\"" + FixtureRole(GetWindow(fixtureToolbar, 4), ink, target, ownPid) +
            "\",\"canvasNext\":\"" + FixtureRole(GetWindow(ink, 2), ink, target, ownPid) + "\"" + api + "}");
    }
#else
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
#endif

    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "process")
        {
            uint requestedPid;
            if (!uint.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out requestedPid) || requestedPid == 0) return 1;
            IntPtr requested = OpenProcess(0x101000 /* SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION */, false, requestedPid);
            if (requested == IntPtr.Zero) return 1;
            try
            {
                FileTime created, exited, kernel, user;
                if (!GetProcessTimes(requested, out created, out exited, out kernel, out user) || WaitForSingleObject(requested, 0) != 258) return 1;
                ulong started = ((ulong)created.High << 32) | created.Low;
                if (started == 0) return 1;
                Console.WriteLine("{\"pid\":" + requestedPid.ToString(CultureInfo.InvariantCulture) +
                    ",\"processStartedAt\":\"" + started.ToString(CultureInfo.InvariantCulture) + "\"}");
                return 0;
            }
            finally { CloseHandle(requested); }
        }
        bool watch = args.Length == 4 && args[0] == "watch";
        bool activate = args.Length == 4 && args[0] == "activate";
#if FIXTURE_ANCHOR_ROLES
        if (args.Length == 12) { fixtureToolbar = new IntPtr(long.Parse(args[11], CultureInfo.InvariantCulture)); Array.Resize(ref args, 11); }
#endif
        bool place = args.Length == 11 && (args[0] == "place" || args[0] == "check");
        if (!watch && !place && !activate && (args.Length != 2 || args[0] != "inspect")) return 1;
        ulong bits;
        if (!ulong.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out bits) || bits == 0 ||
            bits.ToString(CultureInfo.InvariantCulture) != args[1] || (IntPtr.Size == 4 && bits > uint.MaxValue)) return 1;
        IntPtr window = IntPtr.Size == 8 ? new IntPtr(unchecked((long)bits)) : new IntPtr(unchecked((int)bits));
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        if (thread == 0 || pid == 0 || pid > int.MaxValue || GetAncestor(window, 2 /* GA_ROOT */) != window) return 1;
        IntPtr process = OpenProcess(0x101000 /* SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process == IntPtr.Zero) return 1;
        try
        {
            FileTime created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || WaitForSingleObject(process, 0) != 258) return 1;
            ulong started = ((ulong)created.High << 32) | created.Low;
            uint checkedPid;
            // Detect changes during inspection, not a guarantee against same-process HWND reuse.
            if (started == 0 || GetWindowThreadProcessId(window, out checkedPid) != thread || checkedPid != pid ||
                GetAncestor(window, 2) != window || WaitForSingleObject(process, 0) != 258) return 1;
            if (watch || place || activate)
            {
                if (args[2] != pid.ToString(CultureInfo.InvariantCulture) || args[3] != started.ToString(CultureInfo.InvariantCulture)) return 1;
                if (activate)
                {
                    // Fail closed on a changed identity/state. No restore, topmost,
                    // input attachment, retry or ongoing z-order enforcement.
                    if (!IsWindow(window) || !IsWindowVisible(window) || IsIconic(window) ||
                        GetAncestor(window, 2) != window ||
                        GetWindowThreadProcessId(window, out checkedPid) != thread || checkedPid != pid ||
                        WaitForSingleObject(process, 0) != 258) return 1;
                    bool activated = SetForegroundWindow(window);
                    Console.WriteLine(Prefix(args[1], pid, args[3]) + "\"activated\":" + (activated ? "true" : "false") + "}");
                    return 0;
                }
                if (place) return Place(window, process, thread, pid, args);
                return Watch(window, process, thread, pid, args[1], args[3]);
            }
            Console.WriteLine("{\"hwnd\":\"" + args[1] + "\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) +
                ",\"processStartedAt\":\"" + started.ToString(CultureInfo.InvariantCulture) + "\"}");
            return 0;
        }
        finally { CloseHandle(process); }
    }

    private static string Prefix(string hwnd, uint pid, string started)
    {
        return "{\"hwnd\":\"" + hwnd + "\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) +
            ",\"processStartedAt\":\"" + started + "\",";
    }
    private static string Number(long value) { return value.ToString(CultureInfo.InvariantCulture); }
    private static string Box(Rect r)
    {
        return "{\"x\":" + Number(r.Left) + ",\"y\":" + Number(r.Top) + ",\"width\":" + Number((long)r.Right - r.Left) +
            ",\"height\":" + Number((long)r.Bottom - r.Top) + "}";
    }
    private static bool Valid(Rect r) { return r.Right > r.Left && r.Bottom > r.Top; }
    private static bool Same(Rect a, Rect b)
    {
        return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
    }
    private static int Place(IntPtr target, IntPtr process, uint targetThread, uint targetPid, string[] args)
    {
        ulong bits;
        uint ownerPid;
        if (!ulong.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out bits) || bits == 0 ||
            bits.ToString(CultureInfo.InvariantCulture) != args[4] || (IntPtr.Size == 4 && bits > uint.MaxValue) ||
            !uint.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out ownerPid) || ownerPid == 0) return 1;
        IntPtr ink = IntPtr.Size == 8 ? new IntPtr(unchecked((long)bits)) : new IntPtr(unchecked((int)bits));
        if (ink == target) return 1;
        int x, y, width, height;
        if (!int.TryParse(args[6], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out x) ||
            !int.TryParse(args[7], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out y) ||
            !int.TryParse(args[8], out width) || !int.TryParse(args[9], out height) ||
            width <= 0 || height <= 0 || width > 16384 || height > 16384 || (args[10] != "visible" && args[10] != "hidden")) return 1;
        bool visible = args[10] == "visible";
        Rect expected = new Rect();
        expected.Left = x; expected.Top = y;
        long right = (long)x + width, bottom = (long)y + height;
        if (right > int.MaxValue || bottom > int.MaxValue) return 1;
        expected.Right = (int)right; expected.Bottom = (int)bottom;
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) return 1;
        try
        {
            if (!PlacementIdentity(target, ink, process, targetThread, targetPid, ownerPid, visible)) return PlacementRefusal("identity-or-state");
            Rect targetBounds, inkBounds;
            if (DwmGetWindowAttribute(target, 9, out targetBounds, Marshal.SizeOf(typeof(Rect))) != 0 || !Valid(targetBounds)) return PlacementRefusal("target-read");
            if (!GetWindowRect(ink, out inkBounds) || !Same(expected, inkBounds)) return PlacementRefusal("canvas-geometry");
            if (!Same(expected, targetBounds)) return PlacementGeometryRefusal(expected, targetBounds);
            // Only move our own canvas. Inserting behind the current predecessor
            // keeps normal external occluders above it. Never cross a topmost band.
            IntPtr above = GetWindow(target, 3);
#if FIXTURE_ANCHOR_ROLES
            FixtureSnapshot("initial-read", ink, target, ownerPid, above, "");
#endif
            bool usedBoundary = false;
            string firstWriteReadback = null;
            if (above != ink)
            {
                if (args[0] == "check")
                {
                    IntPtr next = GetWindow(ink, 2);
                    uint nextPid;
                    uint nextThread = GetWindowThreadProcessId(next, out nextPid);
                    if (next == IntPtr.Zero || nextThread == 0 || nextPid == 0)
                        return PlacementRefusal("order-check-neighbor-raced");
                    bool owned = nextPid == ownerPid;
                    if (owned && !IsWindowVisible(next))
                    {
                        // Distinguish a hidden interposer from a canvas that
                        // actually fell below the target. Never skip the HWND.
                        IntPtr cursor = next;
                        bool targetBelow = false;
                        for (int step = 0; cursor != IntPtr.Zero && step < 32; step++, cursor = GetWindow(cursor, 2))
                            if (cursor == target) { targetBelow = true; break; }
                        string role = HiddenNeighborRole(ink, next, ownerPid);
                        string reason = targetBelow ? "order-check-own-hidden" : "order-check-own-hidden-target-not-below";
                        return PlacementRefusal(role == null ? "order-check-neighbor-raced" : reason + ":" + role);
                    }
                    if (!owned)
                    {
                        // Classify only relative order, visibility and window role.
                        // Never skip an interposer or change the refusal policy.
                        string relation = "unknown";
                        IntPtr cursor = ink;
                        for (int step = 0; cursor != IntPtr.Zero && step < 32; step++)
                        {
                            cursor = GetWindow(cursor, 2);
                            if (cursor == target) { relation = "target-below"; break; }
                        }
                        if (relation == "unknown")
                        {
                            cursor = ink;
                            for (int step = 0; cursor != IntPtr.Zero && step < 32; step++)
                            {
                                cursor = GetWindow(cursor, 3);
                                if (cursor == target) { relation = "target-above"; break; }
                            }
                        }
                        string neighbor = next == target ? "target" : next == IntPtr.Zero ? "none" : IsWindowVisible(next) ? "visible-other" : "hidden-other";
                        uint checkedNextPid;
                        if (GetWindow(ink, 2) != next || GetWindow(target, 3) != above ||
                            GetWindowThreadProcessId(next, out checkedNextPid) != nextThread || checkedNextPid != nextPid ||
                            (IsWindowVisible(next) ? "visible-other" : "hidden-other") != neighbor)
                            return PlacementRefusal("order-check-neighbor-raced");
                        Console.WriteLine("{\"refusal\":\"order-check-other\",\"checkContext\":\"" + relation + ":" + neighbor + "\"}");
                        return 1;
                    }
                    return PlacementRefusal("order-check-own-visible");
                }
                IntPtr writtenPredecessor = IntPtr.Zero;
                bool wrote = false;
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    if (!PlacementIdentity(target, ink, process, targetThread, targetPid, ownerPid, visible)) return PlacementRefusal("identity-or-state");
                    if (!GetWindowRect(ink, out inkBounds) || !Same(expected, inkBounds)) return PlacementRefusal("canvas-geometry");
                    if (DwmGetWindowAttribute(target, 9, out targetBounds, Marshal.SizeOf(typeof(Rect))) != 0 || !Valid(targetBounds)) return PlacementRefusal("target-read");
                    if (!Same(expected, targetBounds)) return PlacementGeometryRefusal(expected, targetBounds);
                    above = GetWindow(target, 3);
                    if (above == ink) break; // Final exact readback below still applies.
                    if (wrote && above == writtenPredecessor) return UnchangedAnchor(ink, target, ownerPid, above, firstWriteReadback);
                    IntPtr anchor = above;
                    if (above != IntPtr.Zero && (GetWindowLongW(above, -20) & 8) != 0)
                    {
                        uint predecessorPid;
                        uint predecessorThread = GetWindowThreadProcessId(above, out predecessorPid);
                        if (predecessorThread == 0) return PlacementRefusal("order-topmost");
                        if (visible) return PlacementRefusal(predecessorPid == ownerPid || predecessorPid == targetPid
                            ? "order-topmost-fixture-process" : "order-topmost-other-process");
                        anchor = IntPtr.Zero; // HWND_TOP; only the hidden, non-topmost canvas is moved.
                    }
                    if (GetWindow(target, 3) != above)
                    {
                        if (visible || attempt != 0) return PlacementRefusal("order-anchor-changed");
                        continue; // Revalidate geometry and identity on a fresh anchor.
                    }
                    uint flags = 0x0213; // NOMOVE|NOSIZE|NOACTIVATE|NOOWNERZORDER
#if FIXTURE_NO_SEND_CHANGING
                    // Experimental binary only: isolate the changing notification
                    // on the hidden ordinary-band boundary. Verification is unchanged.
                    if (!visible && above != IntPtr.Zero && anchor == IntPtr.Zero) flags |= 0x0400;
#endif
#if FIXTURE_ANCHOR_ROLES
                    FixtureSnapshot("before-api", ink, target, ownerPid, anchor, "");
                    SetLastError(0);
                    bool apiResult = SetWindowPos(ink, anchor, 0, 0, 0, 0, flags);
                    int apiError = Marshal.GetLastWin32Error(); // Capture before any diagnostic read.
                    FixtureSnapshot("after-api", ink, target, ownerPid, anchor,
                        ",\"apiReturned\":" + (apiResult ? "true" : "false") + ",\"lastError\":" + Number(apiError));
                    if (!apiResult) return PlacementRefusal("order-write");
#else
                    if (!SetWindowPos(ink, anchor, 0, 0, 0, 0, flags)) return PlacementRefusal("order-write");
#endif
                    usedBoundary |= above != IntPtr.Zero && anchor == IntPtr.Zero;
                    wrote = true;
                    writtenPredecessor = above;
                    bool inkNextTarget = GetWindow(ink, 2) == target;
                    // Sample both directions immediately after the first boundary write.
                    // The two reads are not atomic and do not authorize placement.
                    if (attempt == 0 && usedBoundary)
                    {
                        bool targetPrevInk = GetWindow(target, 3) == ink;
                        firstWriteReadback = inkNextTarget && targetPrevInk ? "both" :
                            inkNextTarget || targetPrevInk ? "one" : "neither";
                    }
                    if (inkNextTarget) break;
                    // Never replay an unchanged failed placement. A second write
                    // is only allowed against a different observed predecessor.
                    if (visible) return PlacementRefusal("order-readback-visible");
                    if (attempt != 0) return PlacementRefusal("order-readback-retry-exhausted", null, firstWriteReadback);
                    if (GetWindow(target, 3) == above) return UnchangedAnchor(ink, target, ownerPid, above, firstWriteReadback);
                }
            }
            if (!PlacementIdentity(target, ink, process, targetThread, targetPid, ownerPid, visible)) return PlacementRefusal("identity-or-state");
            if (GetWindow(ink, 2) != target) return PlacementRefusal("order-readback-first-verification", null, firstWriteReadback);
            if (!GetWindowRect(ink, out inkBounds) || !Same(expected, inkBounds)) return PlacementRefusal("canvas-geometry");
            if (DwmGetWindowAttribute(target, 9, out targetBounds, Marshal.SizeOf(typeof(Rect))) != 0 || !Valid(targetBounds)) return PlacementRefusal("target-read");
            if (!Same(expected, targetBounds)) return PlacementGeometryRefusal(expected, targetBounds);
            if (GetWindow(target, 3) != ink || GetWindow(ink, 2) != target) return PlacementRefusal("order-readback-final-verification", null, firstWriteReadback);
            Console.WriteLine(Prefix(args[1], targetPid, args[3]) + "\"placed\":true,\"ink\":\"" + args[4] +
                "\",\"ownerPid\":" + Number(ownerPid) + ",\"bounds\":" + Box(inkBounds) + ",\"visible\":" + (visible ? "true" : "false") +
                (usedBoundary ? ",\"boundaryWrite\":true" : "") + WriteReadbackJson(firstWriteReadback) + "}");
            return 0;
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
    private static string WriteReadbackJson(string value)
    {
        return value == null ? "" : ",\"firstBoundaryReadback\":\"" + value + "\"";
    }
    private static int PlacementRefusal(string reason, string orderContext = null, string firstWriteReadback = null)
    {
        Console.WriteLine("{\"refusal\":\"" + reason + "\"" +
            (orderContext == null ? "" : ",\"orderContext\":\"" + orderContext + "\"") + WriteReadbackJson(firstWriteReadback) + "}");
        return 1;
    }
    private static int UnchangedAnchor(IntPtr ink, IntPtr target, uint ownerPid, IntPtr above, string firstWriteReadback)
    {
        IntPtr next = GetWindow(ink, 2);
        if (next == target) return PlacementRefusal("order-readback-unchanged-anchor-raced", null, firstWriteReadback);
        if (next == IntPtr.Zero) return PlacementRefusal("order-readback-unchanged-anchor-no-neighbor", null, firstWriteReadback);
        uint pid;
        if (GetWindowThreadProcessId(next, out pid) == 0) return PlacementRefusal("order-readback-unchanged-anchor-raced", null, firstWriteReadback);
        if (pid != ownerPid) return PlacementRefusal("order-readback-unchanged-anchor-other", null, firstWriteReadback);
        if (IsWindowVisible(next)) return PlacementRefusal("order-readback-unchanged-anchor-own-visible", null, firstWriteReadback);
        // Report only coarse roles, never raw class names, titles or handles.
        // This snapshot is diagnostic and cannot authorize skipping a window.
        string role = HiddenNeighborRole(ink, next, ownerPid);
        if (role == null) return PlacementRefusal("order-readback-unchanged-anchor-raced", null, firstWriteReadback);
        // Keep this bounded and separate from the refusal policy. A miss is
        // unknown, not proof that either HWND is absent from the stack.
        IntPtr cursor = ink;
        string relation = "not-in-range";
        for (int j = 0; cursor != IntPtr.Zero && j < 32; j++)
        {
            cursor = GetWindow(cursor, 3);
            if (cursor == target) { relation = "target-above"; break; }
        }
        if (relation == "not-in-range")
        {
            cursor = ink;
            for (int j = 0; cursor != IntPtr.Zero && j < 32; j++)
            {
                cursor = GetWindow(cursor, 2);
                if (cursor == target) { relation = "target-below"; break; }
            }
        }
        string anchor = above == IntPtr.Zero ? "no-anchor" : (GetWindowLongW(above, -20) & 8) != 0 ? "topmost-anchor" : "ordinary-anchor";
        if (GetWindow(target, 3) != above || GetWindow(ink, 2) != next)
            return PlacementRefusal("order-readback-unchanged-anchor-raced", null, firstWriteReadback);
        return PlacementRefusal("order-readback-unchanged-anchor-own-hidden-" + role, anchor + ":" + relation, firstWriteReadback);
    }
    private static string HiddenNeighborRole(IntPtr ink, IntPtr next, uint ownerPid)
    {
        bool defaultIme = ImmGetDefaultIMEWnd(ink) == next;
        var name = new System.Text.StringBuilder(64);
        int length = GetClassNameW(next, name, name.Capacity);
        IntPtr owner = GetWindow(next, 4); // GW_OWNER
        uint checkedPid;
        if (GetWindow(ink, 2) != next || GetWindowThreadProcessId(next, out checkedPid) == 0 || checkedPid != ownerPid || IsWindowVisible(next))
            return null;
        if (defaultIme && ImmGetDefaultIMEWnd(ink) == next) return "canvas-default-ime";
        if (length <= 0 || length >= name.Capacity - 1) return "unknown";
        string className = name.ToString();
        if (className == "IME" || className == "MSCTFIME UI") return "ime-class";
        if (className == "Intermediate D3D Window" || className == "Chrome_RenderWidgetHostHWND") return "render-class";
        if (className == "OleMainThreadWndClass" || className == "CLIPBRDWNDCLASS") return "ole-class";
        if (className.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal))
            return owner == ink ? "chromium-canvas-owned" : owner == IntPtr.Zero ? "chromium-unowned" : "chromium-other-owner";
        Rect rect;
        if (!GetWindowRect(next, out rect) || GetWindow(ink, 2) != next || IsWindowVisible(next)) return null;
        if (rect.Left == rect.Right || rect.Top == rect.Bottom)
            return owner == IntPtr.Zero ? "other-class-empty-unowned" : owner == ink ? "other-class-empty-canvas-owned" : "other-class-empty-other-owner";
        return "other-class";
    }
    private static int PlacementGeometryRefusal(Rect expected, Rect actual)
    {
        bool sameSize = (long)expected.Right - expected.Left == (long)actual.Right - actual.Left &&
            (long)expected.Bottom - expected.Top == (long)actual.Bottom - actual.Top;
        return PlacementRefusal(sameSize ? "target-position" : "target-size");
    }
    private static bool PlacementIdentity(IntPtr target, IntPtr ink, IntPtr process, uint targetThread, uint targetPid, uint ownerPid, bool visible)
    {
        uint currentTargetPid, inkPid;
        return WaitForSingleObject(process, 0) == 258 &&
            GetWindowThreadProcessId(target, out currentTargetPid) == targetThread && currentTargetPid == targetPid &&
            GetWindowThreadProcessId(ink, out inkPid) != 0 && inkPid == ownerPid &&
            GetAncestor(ink, 2) == ink && IsWindowVisible(target) && !IsIconic(target) &&
            IsWindowVisible(ink) == visible && GetDpiForWindow(target) == 96 && GetDpiForWindow(ink) == 96 &&
            (GetWindowLongW(target, -20) & 8) == 0 && (GetWindowLongW(ink, -20) & 8) == 0;
    }
    // Finite reason codes only. Identity stays in the private scoped protocol;
    // callers must authenticate it before forwarding a reason as diagnostics.
    private static int Unavailable(string prefix, string reason)
    {
        Console.WriteLine(prefix + "\"status\":\"unavailable\",\"reason\":\"" + reason + "\"}");
        Console.Out.Flush();
        return 1;
    }
    private static int Watch(IntPtr window, IntPtr process, uint thread, uint pid, string hwnd, string started)
    {
        string prefix = Prefix(hwnd, pid, started);
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) return Unavailable(prefix, "dpi-context");
        try
        {
            int pendingCount = 0;
            var pendingClock = new System.Diagnostics.Stopwatch();
            while (true)
            {
                uint wait = WaitForSingleObject(process, 0);
                if (wait == 0)
                {
                    Console.WriteLine(prefix + "\"status\":\"closed\"}");
                    Console.Out.Flush();
                    return 0;
                }
                if (wait != 258) return Unavailable(prefix, "process-wait");
                uint currentPid;
                // A missing HWND is only unavailable: same-process reuse cannot be excluded.
                if (!IsWindow(window) || GetWindowThreadProcessId(window, out currentPid) != thread || currentPid != pid ||
                    GetAncestor(window, 2) != window) return Unavailable(prefix, "window-identity");
                string state = IsIconic(window) ? "minimized" : !IsWindowVisible(window) ? "hidden" : "visible";
                if (state != "visible")
                {
                    pendingCount = 0; pendingClock.Reset();
                    Console.WriteLine(prefix + "\"status\":\"" + state + "\"}");
                }
                else
                {
                    // First experimental scope is 100% only; never infer logical size from rounded DIP.
                    if (GetDpiForWindow(window) != 96) return Unavailable(prefix, "unsupported-dpi");
                    if ((GetWindowLongW(window, -20) & 8) != 0) return Unavailable(prefix, "topmost");
                    Rect outer, dwm, checkedOuter, checkedDwm;
                    if (!GetWindowRect(window, out outer) || !Valid(outer)) return Unavailable(prefix, "outer-read");
                    if (DwmGetWindowAttribute(window, 9, out dwm, Marshal.SizeOf(typeof(Rect))) != 0 || !Valid(dwm)) return Unavailable(prefix, "dwm-read");
                    if (!GetWindowRect(window, out checkedOuter)) return Unavailable(prefix, "outer-recheck");
                    if (DwmGetWindowAttribute(window, 9, out checkedDwm, Marshal.SizeOf(typeof(Rect))) != 0) return Unavailable(prefix, "dwm-recheck");
                    if (IsIconic(window) || !IsWindowVisible(window)) return Unavailable(prefix, "state-changed");
                    if (GetDpiForWindow(window) != 96) return Unavailable(prefix, "unsupported-dpi");
                    if (GetWindowThreadProcessId(window, out currentPid) != thread || currentPid != pid) return Unavailable(prefix, "identity-changed");
                    if (WaitForSingleObject(process, 0) != 258) return Unavailable(prefix, "process-changed");
                    if ((GetWindowLongW(window, -20) & 8) != 0) return Unavailable(prefix, "topmost");
                    if (!Same(outer, checkedOuter) || !Same(dwm, checkedDwm))
                    {
                        string reason = !Same(outer, checkedOuter) ? "outer-changed" : "dwm-changed";
                        if (!pendingClock.IsRunning) pendingClock.Start();
                        if (++pendingCount > 10 || pendingClock.ElapsedMilliseconds >= 1000) return Unavailable(prefix, reason);
                        // Do not publish any geometry or promote a prior sample.
                        Console.WriteLine(prefix + "\"status\":\"geometry-pending\",\"reason\":\"" + reason + "\"}");
                        Console.Out.Flush(); Thread.Sleep(20); continue;
                    }
                    pendingCount = 0; pendingClock.Reset();
                    Console.WriteLine(prefix + "\"status\":\"visible\",\"dpi\":96,\"bounds\":" + Box(dwm) +
                        ",\"actualSize\":{\"width\":" + Number((long)outer.Right - outer.Left) +
                        ",\"height\":" + Number((long)outer.Bottom - outer.Top) + "}}");
                }
                Console.Out.Flush();
                Thread.Sleep(100);
            }
        }
        catch (System.IO.IOException) { return 1; }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
}
