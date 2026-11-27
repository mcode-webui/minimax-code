# Drive only the Common Item Dialog created by this installed WebUI launch.
# The caller also bounds this process: a Windows UI Automation provider can block an Invoke call.
#requires -Version 5.1
param(
    [Parameter(Mandatory)][int]$LauncherPid,
    [Parameter(Mandatory)][string]$LauncherEntry,
    [Parameter(Mandatory)][ValidateSet('baseline', 'select', 'cancel')][string]$Action,
    [string]$Directory
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'select' -and ($Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or -not [IO.Directory]::Exists($Directory))) {
    throw 'The selected test directory must be an existing absolute path.'
}

if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'No interactive Windows desktop: the driver is non-interactive or running in Session 0.'
}
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class WebuiTestDesktop {
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool GetUserObjectInformation(
        IntPtr handle, int index, StringBuilder value, uint size, out uint needed);
    public static string Name(IntPtr desktop) {
        var value = new StringBuilder(256);
        uint needed;
        return GetUserObjectInformation(desktop, 2, value, (uint)value.Capacity * 2, out needed) ? value.ToString() : null;
    }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThread {
        public int Size, Flags;
        public IntPtr Active, Focus, Capture, Menu, MoveSize, Caret;
        public Rect CaretRect;
    }
    delegate bool EnumProc(IntPtr handle, IntPtr unused);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThread info);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr child);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr unused);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint msg, IntPtr wp, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    static string Class(IntPtr hwnd) {
        var name = new StringBuilder(128);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }
    public static bool OwnsDialog(IntPtr hwnd, uint expected) {
        uint pid;
        return hwnd != IntPtr.Zero && GetWindowThreadProcessId(hwnd, out pid) != 0 && pid == expected && Class(hwnd) == "#32770";
    }
    public static bool HasShellControls(IntPtr dialog) {
        bool found = false;
        EnumChildWindows(dialog, delegate(IntPtr child, IntPtr unused) {
            var name = Class(child);
            found = name == "SHELLDLL_DefView" || name == "Breadcrumb Parent";
            return !found;
        }, IntPtr.Zero);
        return found;
    }
    static IntPtr Focus(IntPtr dialog) {
        uint pid;
        var info = new GuiThread { Size = Marshal.SizeOf(typeof(GuiThread)) };
        if (GetGUIThreadInfo(GetWindowThreadProcessId(dialog, out pid), ref info) &&
            IsChild(dialog, info.Focus)) return info.Focus;
        return dialog;
    }
    public static IntPtr FocusedEdit(IntPtr dialog) {
        var focus = Focus(dialog);
        if (Class(focus) == "Edit") {
            for (var parent = GetParent(focus); parent != dialog && parent != IntPtr.Zero; parent = GetParent(parent)) {
                var cls = Class(parent);
                if (cls == "Address Band Root" || cls == "Breadcrumb Parent" || cls == "ReBarWindow32") return focus;
            }
        }
        return IntPtr.Zero;
    }
    // Post to this dialog's input queue. A different foreground window never receives keys or the path.
    public static void Key(IntPtr dialog, int key, int scanCode) {
        var focus = Focus(dialog);
        int data = 1 | (scanCode << 16);
        if (!PostMessage(focus, 0x100, (IntPtr)key, (IntPtr)data) ||
            !PostMessage(focus, 0x101, (IntPtr)key, (IntPtr)(data | unchecked((int)0xC0000000))))
            throw new InvalidOperationException("Could not post a key to the identified dialog.");
    }
    public static void ClickBreadcrumb(IntPtr dialog) {
        // Clicking the free area at the right of the breadcrumb switches it to its path editor.
        EnumChildWindows(dialog, delegate(IntPtr child, IntPtr unused) {
            if (Class(child) != "ToolbarWindow32" || Class(GetParent(child)) != "Breadcrumb Parent" || !IsWindowVisible(child)) return true;
            Rect r;
            if (!GetClientRect(child, out r) || r.Right < 8) return true;
            var point = (IntPtr)((r.Bottom / 2 << 16) | (r.Right - 5));
            PostMessage(child, 0x201, (IntPtr)1, point);
            PostMessage(child, 0x202, IntPtr.Zero, point);
            return false;
        }, IntPtr.Zero);
    }
    public static string EditValue(IntPtr dialog, IntPtr edit, bool write, string replacement) {
        if (edit == IntPtr.Zero || edit != FocusedEdit(dialog))
            throw new InvalidOperationException("The dialog's focused edit changed.");
        IntPtr result;
        if (write && SendMessageTimeout(edit, 0xC, IntPtr.Zero,
            new StringBuilder(replacement), 2, 1000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The address edit did not accept WM_SETTEXT.");
        var value = new StringBuilder(32768);
        if (SendMessageTimeout(edit, 0xD, (IntPtr)value.Capacity, value, 2, 1000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The address edit did not answer WM_GETTEXT.");
        return value.ToString();
    }
    public static bool Click(IntPtr dialog, int id) {
        IntPtr button = IntPtr.Zero;
        EnumChildWindows(dialog, delegate(IntPtr child, IntPtr unused) {
            if (GetDlgCtrlID(child) == id && Class(child) == "Button" && IsWindowVisible(child) && IsWindowEnabled(child)) {
                button = child;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return button != IntPtr.Zero && PostMessage(button, 0xF5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
    }
    public static string Controls(IntPtr dialog) {
        var controls = new List<string>();
        EnumChildWindows(dialog, delegate(IntPtr child, IntPtr unused) {
            if (IsWindowVisible(child)) controls.Add(Class(child) + "#" + GetDlgCtrlID(child));
            return controls.Count < 80;
        }, IntPtr.Zero);
        return String.Join(", ", controls.ToArray());
    }
    public static void Capture(IntPtr dialog, string filename) {
        Rect r;
        if (!GetWindowRect(dialog, out r)) return;
        using (var image = new Bitmap(r.Right - r.Left, r.Bottom - r.Top)) {
            using (var graphics = Graphics.FromImage(image)) {
                var dc = graphics.GetHdc();
                try { if (!PrintWindow(dialog, dc, 2)) return; }
                finally { graphics.ReleaseHdc(dc); }
            }
            image.Save(filename, ImageFormat.Png);
        }
    }
}
'@
$inputDesktop = [WebuiTestDesktop]::OpenInputDesktop(0, $false, 1) # DESKTOP_READOBJECTS
if ($inputDesktop -eq [IntPtr]::Zero) { throw 'No accessible Windows input desktop (locked or disconnected).' }
try {
    $threadDesktop = [WebuiTestDesktop]::GetThreadDesktop([WebuiTestDesktop]::GetCurrentThreadId())
    $inputName = [WebuiTestDesktop]::Name($inputDesktop)
    if (-not $inputName -or $inputName -ne [WebuiTestDesktop]::Name($threadDesktop)) {
        throw 'The driver is not attached to the active Windows input desktop.'
    }
} finally {
    [void][WebuiTestDesktop]::CloseDesktop($inputDesktop)
}

Add-Type -AssemblyName @('UIAutomationClient', 'UIAutomationTypes')
$launchRoot = Get-Process -Id $LauncherPid
# Keep the process handles open for the duration of the observation to prevent PID reuse.
[void]$launchRoot.Handle
if ($launchRoot.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
    throw "The launcher PID $LauncherPid is in another Windows session."
}
if (-not [IO.Path]::IsPathRooted($LauncherEntry)) { throw 'The installed launcher entry must be an absolute path.' }
$launcherPath = (Get-Item -LiteralPath $LauncherEntry -ErrorAction Stop).FullName
# A Windows npm bin shim may put cmd.exe above node.exe. Search only this launch tree.
# The entry point is Node's first argument, whether the absolute path needs quoting or not.
function Find-LauncherNode($process) {
    if ($process.Name -eq 'node.exe' -and $process.CommandLine -match '^\s*(?:"[^"]+"|\S+)\s+(?:"([^"]+)"|(\S+))') {
        $entry = $Matches[1] + $Matches[2]
        if ([IO.Path]::IsPathRooted($entry) -and [IO.Path]::GetFullPath($entry) -eq $launcherPath) {
            return $process
        }
    }
    foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.ProcessId)" -Property $processFields)) {
        Find-LauncherNode $child
    }
}
$processFields = @('ProcessId', 'Name', 'CommandLine')
$startProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$LauncherPid" -Property $processFields
$nodes = @(Find-LauncherNode $startProcess)
if ($nodes.Count -ne 1) { throw "Expected one installed WebUI Node entry in the tree of PID $LauncherPid; found $($nodes.Count)." }
$launcher = Get-Process -Id $nodes[0].ProcessId
[void]$launcher.Handle
# A common dialog can be owned by the launcher or by a helper at any depth.
# Resolve ancestry only for visible Win32 dialogs on this test desktop.
function Test-LauncherDescendant([int]$processId) {
    $visited = @{}
    while ($processId -gt 0 -and -not $visited.ContainsKey($processId)) {
        if ($processId -eq $launcher.Id) { return $true }
        $visited[$processId] = $true
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -Property ParentProcessId
        if (-not $process) { return $false }
        $processId = $process.ParentProcessId
    }
    return $false
}
$clock = [Diagnostics.Stopwatch]::StartNew()
$picker = $null
$dialog = $null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = [System.Windows.Automation.TreeScope]::Children
$dialogClass = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
while ($clock.Elapsed.TotalSeconds -lt 20) {
    if ($launcher.HasExited) { throw "The WebUI launcher PID $LauncherPid exited before showing the chooser." }
    $visible = @($root.FindAll($children, $dialogClass) | Where-Object {
        $current = $_.Current
        -not $current.IsOffscreen -and (Test-LauncherDescendant $current.ProcessId) -and
            [WebuiTestDesktop]::OwnsDialog([IntPtr]$current.NativeWindowHandle, $current.ProcessId) -and
            ($Action -eq 'baseline' -or [WebuiTestDesktop]::HasShellControls([IntPtr]$current.NativeWindowHandle))
    })
    if ($Action -eq 'baseline') {
        if ($visible.Count -gt 0) { throw 'The installed launcher already owns a visible dialog before the project selection.' }
        return
    }
    if ($visible.Count -gt 1) { throw 'The installed launcher owns multiple visible Shell dialogs; the chooser is ambiguous.' }
    if ($visible.Count -eq 1) {
        $dialog = $visible[0]
        $picker = Get-Process -Id $dialog.Current.ProcessId
        [void]$picker.Handle
        break
    }
    Start-Sleep -Milliseconds 120
}
if (-not $dialog) { throw "The installed launcher PID $($launcher.Id) did not display a visible Common Item Dialog." }
$window = [IntPtr]$dialog.Current.NativeWindowHandle
if (-not [WebuiTestDesktop]::OwnsDialog($window, $picker.Id)) { throw 'The visible UI element has no matching native dialog handle.' }
function Open-AddressEdit {
    # F4 opens the Shell address bar without a modifier or global keyboard input.
    foreach ($method in @('breadcrumb', 'F4')) {
        if ($method -eq 'breadcrumb') { [WebuiTestDesktop]::ClickBreadcrumb($window) }
        else { [WebuiTestDesktop]::Key($window, 0x73, 0x3e) }
        $wait = [Diagnostics.Stopwatch]::StartNew()
        do {
            $edit = [WebuiTestDesktop]::FocusedEdit($window)
            if ($edit -ne [IntPtr]::Zero) { return $edit }
            Start-Sleep -Milliseconds 100
        } while ($wait.ElapsedMilliseconds -lt 2000)
    }
    throw 'The Shell address bar did not enter edit mode.'
}
function Save-DialogImage {
    if (-not $env:WEBUI_BROWSER_OUTPUT_DIR) { return }
    try {
        [void][IO.Directory]::CreateDirectory($env:WEBUI_BROWSER_OUTPUT_DIR)
        $file = Join-Path $env:WEBUI_BROWSER_OUTPUT_DIR "windows-native-folder-$Action.png"
        [WebuiTestDesktop]::Capture($window, $file)
    } catch { Write-Warning 'Could not capture the native dialog window.' }
}
$stage = 'wait for the chooser to take the foreground'
try {
    # A visible Shell dialog can still be behind the browser. Observe its exact HWND
    # before the driver sends any input, which could itself activate the dialog.
    $activation = [Diagnostics.Stopwatch]::StartNew()
    while ([WebuiTestDesktop]::GetForegroundWindow() -ne $window) {
        if ($picker.HasExited) { throw 'The chooser exited before taking the foreground.' }
        if ($activation.ElapsedMilliseconds -ge 3000) { throw 'The visible chooser did not become the foreground window within 3 seconds.' }
        Start-Sleep -Milliseconds 50
    }
    Write-Output "Windows folder dialog PID $($picker.Id): observed foreground HWND $window before $Action."
    $stage = 'wait for visible chooser controls'
    # Shell creates the top-level HWND before it finishes populating its controls.
    $ready = [Diagnostics.Stopwatch]::StartNew()
    while (-not [WebuiTestDesktop]::Controls($window) -and $ready.ElapsedMilliseconds -lt 3000) {
        Start-Sleep -Milliseconds 100
    }
    if ($Action -eq 'select') {
        $stage = 'open the Shell address bar'
        $edit = Open-AddressEdit
        $stage = 'enter the target directory'
        if ([WebuiTestDesktop]::EditValue($window, $edit, $true, $Directory) -ne $Directory) {
            throw 'The address bar did not accept the exact target directory.'
        }
        [WebuiTestDesktop]::Key($window, 0x0d, 0x1c) # Enter
        $stage = 'wait for Shell navigation'
        $navigation = [Diagnostics.Stopwatch]::StartNew()
        while ([WebuiTestDesktop]::FocusedEdit($window) -eq $edit) {
            if ($navigation.ElapsedMilliseconds -gt 4000) { throw 'The Shell did not leave address editing after Enter.' }
            Start-Sleep -Milliseconds 100
        }
        $stage = 'read back the navigated address'
        $edit = Open-AddressEdit
        $current = [WebuiTestDesktop]::EditValue($window, $edit, $false, '')
        if ($current.TrimEnd('\') -ne $Directory.TrimEnd('\')) { throw 'The Shell current directory differs from the target.' }
        [WebuiTestDesktop]::Key($window, 0x1b, 0x01) # Escape address editing
        $buttonId = 1 # IDOK
    } else {
        $buttonId = 2 # IDCANCEL
    }
    $stage = "click the $Action button"
    Save-DialogImage
    $ready.Restart()
    while (-not [WebuiTestDesktop]::Click($window, $buttonId)) {
        if ($ready.ElapsedMilliseconds -gt 4000) { throw 'The common dialog did not expose its enabled button.' }
        Start-Sleep -Milliseconds 100
    }
    $stage = 'wait for the native chooser to close'
    $ready.Restart()
    while ([WebuiTestDesktop]::OwnsDialog($window, $picker.Id) -and [WebuiTestDesktop]::IsWindowVisible($window)) {
        if ($ready.ElapsedMilliseconds -ge 5000) { throw 'The chooser remained open after clicking the dialog button.' }
        Start-Sleep -Milliseconds 100
    }
} catch {
    $controls = '(dialog closed)'
    if ([WebuiTestDesktop]::OwnsDialog($window, $picker.Id)) {
        $controls = [WebuiTestDesktop]::Controls($window)
        Save-DialogImage
    }
    throw "Native dialog PID $($picker.Id), stage '$stage': $($_.Exception.Message) Visible window classes and numeric IDs: $controls"
}
Write-Output "Windows folder dialog PID $($picker.Id): completed $Action."
