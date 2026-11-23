#requires -Version 5.1
# Hidden geometry measurement only. The script has no window-handle inputs.

$stage = 'windows-required'
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'windows-required' }
    $stage = 'compile'
    Add-Type -ErrorAction Stop -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace MeetingWindowP0EdgeSizeNative
{
    public static class Probe
    {
        private const uint WS_POPUP = 0x80000000;
        private const uint WS_EX_NOACTIVATE = 0x08000000;
        private static readonly IntPtr PMv2 = new IntPtr(-4);

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect
        {
            internal int Left, Top, Right, Bottom;

            internal Rect(int left, int top, int right, int bottom)
            {
                Left = left; Top = top; Right = right; Bottom = bottom;
            }

            internal bool Matches(Rect other)
            {
                return Left == other.Left && Top == other.Top && Right == other.Right && Bottom == other.Bottom;
            }

            internal Bounds ToBounds()
            {
                return new Bounds { x = Left, y = Top, width = Right - Left, height = Bottom - Top };
            }
        }

        public sealed class Bounds
        {
            public int x { get; set; }
            public int y { get; set; }
            public int width { get; set; }
            public int height { get; set; }
        }

        public sealed class Sample
        {
            public string role { get; set; }
            public Bounds requestedPx { get; set; }
            public Bounds actualPx { get; set; }
            public uint dpi { get; set; }
            public bool exact { get; set; }
        }

        public sealed class Result
        {
            public Sample[] samples { get; set; }
            public string failureStage { get; set; }
            public bool cleanupOk { get; set; }
            public bool exact { get; set; }
        }

        // Top/bottom include the corners; left/right fit strictly between them.
        private static Rect[] Plan(Rect target, int thickness)
        {
            return new[] {
                target,
                new Rect(target.Left, target.Top, target.Right, target.Top + thickness),
                new Rect(target.Left, target.Bottom - thickness, target.Right, target.Bottom),
                new Rect(target.Left, target.Top + thickness, target.Left + thickness, target.Bottom - thickness),
                new Rect(target.Right - thickness, target.Top + thickness, target.Right, target.Bottom - thickness)
            };
        }

        public static Result Measure()
        {
            // Fixed synthetic placement on the primary display; all dimensions are native px.
            Rect[] requested = Plan(new Rect(64, 64, 304, 304), 8);
            string[] roles = { "target", "top", "bottom", "left", "right" };
            IntPtr[] ownWindows = new IntPtr[roles.Length];
            Sample[] samples = new Sample[roles.Length];
            Result result = new Result { failureStage = "pmv2", cleanupOk = true };
            IntPtr previous = SetThreadDpiAwarenessContext(PMv2);
            if (previous == IntPtr.Zero) return result;

            try
            {
                result.failureStage = "create";
                for (int i = 0; i < ownWindows.Length; i++)
                {
                    Bounds rect = requested[i].ToBounds();
                    // System STATIC class, no parent/owner, menu or title. No WS_VISIBLE and no show call.
                    ownWindows[i] = CreateWindowExW(WS_EX_NOACTIVATE, "STATIC", null, WS_POPUP,
                        rect.x, rect.y, rect.width, rect.height,
                        IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                    if (ownWindows[i] == IntPtr.Zero) return result;
                }

                result.exact = true;
                for (int i = 0; i < ownWindows.Length; i++)
                {
                    IntPtr window = ownWindows[i];
                    result.failureStage = "hidden-pmv2";
                    if (IsWindowVisible(window) ||
                        !AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), PMv2)) return result;

                    result.failureStage = "readback";
                    Rect actual;
                    if (!GetWindowRect(window, out actual)) return result;
                    uint dpi = GetDpiForWindow(window);
                    if (dpi == 0) return result;

                    bool exact = requested[i].Matches(actual);
                    result.exact &= exact;
                    samples[i] = new Sample {
                        role = roles[i], requestedPx = requested[i].ToBounds(),
                        actualPx = actual.ToBounds(), dpi = dpi, exact = exact
                    };
                }
                result.samples = samples;
                result.failureStage = null;
                return result;
            }
            finally
            {
                // Synchronous, same-thread teardown, including partial creation. No retries or message loop.
                for (int i = ownWindows.Length - 1; i >= 0; i--)
                    if (ownWindows[i] != IntPtr.Zero && !DestroyWindow(ownWindows[i])) result.cleanupOk = false;
                if (SetThreadDpiAwarenessContext(previous) == IntPtr.Zero) result.cleanupOk = false;
            }
        }

        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
        [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style,
            int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll", ExactSpelling = true)]
        private static extern bool DestroyWindow(IntPtr window);
    }
}
'@

    $stage = 'native-measurement'
    $result = [MeetingWindowP0EdgeSizeNative.Probe]::Measure()
    if ($result.failureStage -or -not $result.cleanupOk) {
        $stage = 'cleanup'
        if ($result.failureStage) { $stage = $result.failureStage }
        @{ type = 'error'; measurement = 'hidden'; stage = $stage; cleanupOk = $result.cleanupOk } |
            ConvertTo-Json -Compress
        exit 1
    }

    @{ type = 'edge-size-native'; measurement = 'hidden'; dpiAwareness = 'PMv2';
        exact = $result.exact; samples = $result.samples } | ConvertTo-Json -Depth 5 -Compress
    if ($result.exact) { exit 0 }
    exit 2
} catch {
    # Never serialize exceptions (which can include source paths and compiler diagnostics).
    @{ type = 'error'; measurement = 'hidden'; stage = $stage } | ConvertTo-Json -Compress
    exit 1
}
