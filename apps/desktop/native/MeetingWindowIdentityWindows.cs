// Experimental inspector/observer; only `place` may reorder a caller-owned canvas.
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
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr window, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    private static int Main(string[] args)
    {
        bool watch = args.Length == 4 && args[0] == "watch";
        bool place = args.Length == 11 && (args[0] == "place" || args[0] == "check");
        if (!watch && !place && (args.Length != 2 || args[0] != "inspect")) return 1;
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
            if (watch || place)
            {
                if (args[2] != pid.ToString(CultureInfo.InvariantCulture) || args[3] != started.ToString(CultureInfo.InvariantCulture)) return 1;
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
            if (!PlacementIdentity(target, ink, process, targetThread, targetPid, ownerPid, visible)) return 1;
            Rect targetBounds, inkBounds;
            if (DwmGetWindowAttribute(target, 9, out targetBounds, Marshal.SizeOf(typeof(Rect))) != 0 ||
                !Same(expected, targetBounds) || !GetWindowRect(ink, out inkBounds) || !Same(expected, inkBounds)) return 1;
            // Only move our own canvas. Inserting behind the current predecessor
            // keeps normal external occluders above it. Never cross a topmost band.
            IntPtr above = GetWindow(target, 3);
            if (above != ink)
            {
                if (args[0] == "check") return 1;
                if (above != IntPtr.Zero && (GetWindowLongW(above, -20) & 8) != 0) return 1;
                if (!SetWindowPos(ink, above, 0, 0, 0, 0, 0x0213 /* NOMOVE|NOSIZE|NOACTIVATE|NOOWNERZORDER */)) return 1;
            }
            if (!PlacementIdentity(target, ink, process, targetThread, targetPid, ownerPid, visible) ||
                GetWindow(ink, 2) != target || !GetWindowRect(ink, out inkBounds) || !Same(expected, inkBounds) ||
                DwmGetWindowAttribute(target, 9, out targetBounds, Marshal.SizeOf(typeof(Rect))) != 0 || !Same(expected, targetBounds)) return 1;
            Console.WriteLine(Prefix(args[1], targetPid, args[3]) + "\"placed\":true,\"ink\":\"" + args[4] +
                "\",\"ownerPid\":" + Number(ownerPid) + ",\"bounds\":" + Box(inkBounds) + ",\"visible\":" + (visible ? "true" : "false") + "}");
            return 0;
        }
        finally { SetThreadDpiAwarenessContext(previous); }
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
    private static int Watch(IntPtr window, IntPtr process, uint thread, uint pid, string hwnd, string started)
    {
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) return 1;
        string prefix = Prefix(hwnd, pid, started);
        try
        {
            while (true)
            {
                uint wait = WaitForSingleObject(process, 0);
                if (wait == 0)
                {
                    Console.WriteLine(prefix + "\"status\":\"closed\"}");
                    Console.Out.Flush();
                    return 0;
                }
                if (wait != 258) return 1;
                uint currentPid;
                // A missing HWND is only unavailable: same-process reuse cannot be excluded.
                if (!IsWindow(window) || GetWindowThreadProcessId(window, out currentPid) != thread || currentPid != pid ||
                    GetAncestor(window, 2) != window) return 1;
                string state = IsIconic(window) ? "minimized" : !IsWindowVisible(window) ? "hidden" : "visible";
                if (state != "visible")
                    Console.WriteLine(prefix + "\"status\":\"" + state + "\"}");
                else
                {
                    // First experimental scope is 100% only; never infer logical size from rounded DIP.
                    if (GetDpiForWindow(window) != 96 || (GetWindowLongW(window, -20) & 8) != 0) return 1;
                    Rect outer, dwm, checkedOuter, checkedDwm;
                    if (!GetWindowRect(window, out outer) || !Valid(outer) ||
                        DwmGetWindowAttribute(window, 9, out dwm, Marshal.SizeOf(typeof(Rect))) != 0 || !Valid(dwm) ||
                        !GetWindowRect(window, out checkedOuter) ||
                        DwmGetWindowAttribute(window, 9, out checkedDwm, Marshal.SizeOf(typeof(Rect))) != 0 ||
                        !Same(outer, checkedOuter) || !Same(dwm, checkedDwm)) return 1;
                    if (IsIconic(window) || !IsWindowVisible(window) || GetDpiForWindow(window) != 96 ||
                        GetWindowThreadProcessId(window, out currentPid) != thread || currentPid != pid || WaitForSingleObject(process, 0) != 258) return 1;
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
