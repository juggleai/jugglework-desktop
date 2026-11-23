#requires -Version 5.1
# Private helper for the standalone Node launcher. stdin carries no commands or HWNDs.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 1 }

$stage = 'compile'
try {
    Add-Type -ErrorAction Stop -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace MeetingWindowP0VisibleEdges
{
    public static class Probe
    {
        private const uint WS_POPUP = 0x80000000;
        private const uint WS_EX_PASSIVE = 0x080800A0; // NOACTIVATE | LAYERED | TOOLWINDOW | TRANSPARENT
        private const int WS_EX_TOPMOST = 8;
        private const uint GW_HWNDNEXT = 2;
        private static readonly IntPtr PMv2 = new IntPtr(-4);

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect { internal int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct Message
        {
            internal IntPtr Window;
            internal uint Id;
            internal UIntPtr WParam;
            internal IntPtr LParam;
            internal uint Time;
            internal int X, Y;
            internal uint Private;
        }

        private static string Bool(bool value) { return value ? "true" : "false"; }

        private static void Write(string record)
        {
            Console.WriteLine(record);
            Console.Out.Flush();
        }

        private static uint OwnerThread(IntPtr window)
        {
            uint pid;
            return GetWindowThreadProcessId(window, out pid);
        }

        public static int Run()
        {
            string[] roles = { "target", "top", "bottom", "left", "right" };
            // Same synthetic plan as the hidden DPI probe; top/bottom include corners.
            int[,] plan = { {64, 64, 240, 240}, {64, 64, 240, 8}, {64, 296, 240, 8},
                            {64, 72, 8, 224}, {296, 72, 8, 224} };
            IntPtr[] own = new IntPtr[roles.Length];
            uint thread = GetCurrentThreadId();
            IntPtr previous = IntPtr.Zero;
            string stage = "pmv2";
            bool failed = false;
            try
            {
                previous = SetThreadDpiAwarenessContext(PMv2);
                if (previous == IntPtr.Zero) throw new InvalidOperationException();

                // EOF (or any unexpected input) requests teardown. Only this STA thread
                // touches HWNDs. The reader never blocks teardown or process exit.
                using (var stop = new ManualResetEvent(false))
                {
                    var reader = new Thread(delegate() {
                        try { using (var input = Console.OpenStandardInput()) { input.ReadByte(); } } catch { }
                        try { stop.Set(); } catch (ObjectDisposedException) { }
                    });
                    reader.IsBackground = true;
                    reader.Start();
                    var elapsed = Stopwatch.StartNew();

                    stage = "work-area";
                    Rect work;
                    // SPI_GETWORKAREA: primary work area, in physical pixels.
                    if (!SystemParametersInfoW(0x0030, 0, out work, 0) ||
                        work.Left > 64 || work.Top > 64 || work.Right < 304 || work.Bottom < 304)
                        throw new InvalidOperationException();

                    stage = "create";
                    for (int i = 0; i < own.Length; i++)
                    {
                        if (stop.WaitOne(0)) return 1;
                        // Standard STATIC class paints the dark fixture (SS_BLACKRECT) and
                        // light edges (SS_WHITERECT); no adornments, owner or child windows.
                        own[i] = CreateWindowExW(WS_EX_PASSIVE, "STATIC", null, WS_POPUP | (i == 0 ? 4u : 6u),
                            plan[i,0], plan[i,1], plan[i,2], plan[i,3],
                            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                        // A layered window with WS_EX_TRANSPARENT passes mouse input through.
                        if (own[i] == IntPtr.Zero || !SetLayeredWindowAttributes(own[i], 0, 255, 2))
                            throw new InvalidOperationException();
                    }

                    stage = "show";
                    for (int i = own.Length - 1; i >= 0; i--)
                    {
                        if (stop.WaitOne(0)) return 1;
                        // Leave the first shown strip in its existing band. Insert each
                        // remaining window directly BELOW the previously shown owned window.
                        IntPtr after = i == own.Length - 1 ? IntPtr.Zero : own[i + 1];
                        uint flags = 0x0053; // NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW
                        if (after == IntPtr.Zero) flags |= 0x0004; // NOZORDER
                        else if (OwnerThread(after) != thread || (GetWindowLongW(after, -20) & WS_EX_TOPMOST) != 0)
                            throw new InvalidOperationException();
                        if (OwnerThread(own[i]) != thread || !SetWindowPos(own[i], after, 0, 0, 0, 0, flags))
                            throw new InvalidOperationException();
                    }

                    stage = "readback";
                    while (!stop.WaitOne(0))
                    {
                        if (elapsed.ElapsedMilliseconds >= 30000)
                        {
                            stage = "native-timeout";
                            throw new InvalidOperationException();
                        }
                        Message msg;
                        for (int i = 0; i < 64 && PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1); i++)
                        {
                            if (msg.Id == 0x0012) throw new InvalidOperationException(); // WM_QUIT
                            DispatchMessageW(ref msg);
                        }

                        var samples = new string[own.Length];
                        bool accepted = true;
                        for (int i = 0; i < own.Length; i++)
                        {
                            IntPtr window = own[i];
                            Rect actual;
                            if (OwnerThread(window) != thread || !GetWindowRect(window, out actual))
                                throw new InvalidOperationException();
                            int style = GetWindowLongW(window, -20); // GWL_EXSTYLE fits in a LONG
                            uint dpi = GetDpiForWindow(window);
                            bool pmv2 = AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), PMv2);
                            bool visible = IsWindowVisible(window);
                            bool topmost = (style & WS_EX_TOPMOST) != 0;
                            bool passive = (style & WS_EX_PASSIVE) == WS_EX_PASSIVE;
                            IntPtr next = i == 0 ? IntPtr.Zero : GetWindow(window, GW_HWNDNEXT);
                            bool adjacent = i == 0 || next == own[i - 1];
                            int nextIndex = next == IntPtr.Zero ? -1 : Array.IndexOf(own, next);
                            string below = i == 0 ? "null" : "\"" + (next == IntPtr.Zero ? "none" :
                                nextIndex < 0 ? "external" : roles[nextIndex]) + "\"";
                            int width = actual.Right - actual.Left, height = actual.Bottom - actual.Top;
                            accepted &= actual.Left == plan[i,0] && actual.Top == plan[i,1] &&
                                width == plan[i,2] && height == plan[i,3] && dpi == 96 && pmv2 &&
                                visible && passive && !topmost && adjacent;
                            samples[i] = String.Format(CultureInfo.InvariantCulture,
                                "{{\"role\":\"{0}\",\"px\":{{\"x\":{1},\"y\":{2},\"width\":{3},\"height\":{4}}},\"dpi\":{5},\"pmv2\":{6},\"visible\":{7},\"topmost\":{8},\"passive\":{9},\"adjacent\":{10},\"below\":{11}}}",
                                roles[i], actual.Left, actual.Top, width, height, dpi, Bool(pmv2),
                                Bool(visible), Bool(topmost), Bool(passive), i == 0 ? "null" : Bool(adjacent), below);
                        }
                        Write("{\"type\":\"sample\",\"windows\":[" + String.Join(",", samples) + "]}");
                        // Mismatched readback goes to the launcher for diagnostics, then
                        // remove the windows locally without waiting for the launcher.
                        if (!accepted) { failed = true; break; }
                        stop.WaitOne(100);
                    }
                }
            }
            catch
            {
                failed = true;
                Write("{\"type\":\"error\",\"stage\":\"" + stage + "\"}");
            }
            finally
            {
                bool cleanupOk = true;
                for (int i = own.Length - 1; i >= 0; i--)
                {
                    if (own[i] == IntPtr.Zero) continue;
                    if (OwnerThread(own[i]) != thread || !DestroyWindow(own[i])) cleanupOk = false;
                }
                if (previous != IntPtr.Zero && SetThreadDpiAwarenessContext(previous) == IntPtr.Zero) cleanupOk = false;
                if (!cleanupOk)
                {
                    failed = true;
                    Write("{\"type\":\"error\",\"stage\":\"cleanup\"}");
                }
                else
                {
                    Write("{\"type\":\"cleanup-complete\"}");
                }
            }
            return failed ? 1 : 0;
        }

        [DllImport("kernel32.dll", ExactSpelling = true)] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", ExactSpelling = true)] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool SystemParametersInfoW(uint action, uint parameter, out Rect rect, uint flags);
        [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style,
            int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern int GetWindowLongW(IntPtr hwnd, int index);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool PeekMessageW(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern IntPtr DispatchMessageW(ref Message msg);
        [DllImport("user32.dll", ExactSpelling = true)] private static extern bool DestroyWindow(IntPtr hwnd);
    }
}
'@
    $stage = 'readback'
    exit ([MeetingWindowP0VisibleEdges.Probe]::Run())
} catch {
    [Console]::WriteLine(('{"type":"error","stage":"' + $stage + '"}'))
    exit 1
}
