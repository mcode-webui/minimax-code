# Drive only the Common Item Dialog created by this installed WebUI launch.
# The caller also bounds this process: a Windows UI Automation provider can block an Invoke call.
#requires -Version 5.1
param(
    [Parameter(Mandatory)][int]$LauncherPid,
    [Parameter(Mandatory)][string]$PickerScript,
    [Parameter(Mandatory)][ValidateSet('select', 'cancel')][string]$Action,
    [string]$Directory
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'select' -and ($Directory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or -not [IO.Directory]::Exists($Directory))) {
    throw 'The selected test directory must be an existing absolute path.'
}

if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'No interactive Windows desktop: the driver is non-interactive or running in Session 0.'
}
Add-Type -TypeDefinition @'
using System;
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
$launcherPath = Join-Path (Get-Item -LiteralPath $PickerScript).DirectoryName 'mcode-webui.mjs'
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
# Node encodes the UTF-8 source (including its original line endings) as UTF-16LE.
# Compare the argument, never print the encoded command or inspect unrelated processes.
$sourceBytes = [IO.File]::ReadAllBytes($PickerScript)
$source = [Text.Encoding]::UTF8.GetString($sourceBytes)
$payload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
$expectedArgument = '-EncodedCommand\s+"?' + [regex]::Escape($payload) + '"?\s*$'
$filter = "ParentProcessId=$($launcher.Id) AND Name='powershell.exe'"
$clock = [Diagnostics.Stopwatch]::StartNew()
$picker = $null
$dialog = $null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = [System.Windows.Automation.TreeScope]::Children
$descendants = [System.Windows.Automation.TreeScope]::Descendants
function Find-DialogControl([string]$id) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    $dialog.FindFirst($descendants, $condition)
}
$field = $null
while ($clock.Elapsed.TotalSeconds -lt 20) {
    if ($launcher.HasExited) { throw "The WebUI launcher PID $LauncherPid exited before showing the chooser." }
    if (-not $picker) {
        $matchesScript = @(Get-CimInstance Win32_Process -Filter $filter -Property $processFields |
            Where-Object { $_.CommandLine -cmatch $expectedArgument })
        if ($matchesScript.Count -gt 1) { throw 'More than one child matches the installed picker script.' }
        if ($matchesScript.Count -eq 1) {
            $picker = Get-Process -Id $matchesScript[0].ProcessId -ErrorAction SilentlyContinue
            if ($picker) {
                [void]$picker.Handle
                $pidCondition = [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$picker.Id)
            }
        }
    }
    if ($picker) {
        if ($picker.HasExited) { throw "The matching PowerShell PID $($picker.Id) exited without showing its folder dialog." }
        $visible = @($root.FindAll($children, $pidCondition) |
            Where-Object { $_.Current.ClassName -eq '#32770' -and -not $_.Current.IsOffscreen })
        if ($visible.Count -gt 1) { throw "Ambiguous chooser: PID $($picker.Id) owns multiple visible dialogs." }
        if ($visible.Count -eq 1) {
            $dialog = $visible[0]
            # Validate the common file dialog, including when the test is only cancelling.
            $field = Find-DialogControl 'FileNameControlHost'
            if (-not $field) { $field = Find-DialogControl '1148' } # cmb13
            if ($field) { break }
        }
    }
    Start-Sleep -Milliseconds 120
}
if (-not $picker) { throw "No PowerShell child of launcher PID $LauncherPid matched the installed chooser script." }
if (-not $dialog) { throw "The matching PowerShell PID $($picker.Id) did not display a visible #32770 dialog." }
if (-not $field) { throw 'The observed #32770 window never exposed the folder-name control.' }
function Invoke-DialogButton([string]$id) {
    $button = Find-DialogControl $id
    if (-not $button -or -not $button.Current.IsEnabled -or $button.Current.IsOffscreen) {
        throw "The chooser does not have a visible, enabled button with automation ID $id."
    }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
if ($Action -eq 'cancel') {
    Invoke-DialogButton '2' # IDCANCEL
} else {
    # The address bar also has an edit control. Scope the search to the folder-name combo.
    if ($field.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) {
        $editCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $field = $field.FindFirst($descendants, $editCondition)
    }
    if (-not $field) { throw 'The folder-name combo has no editable field.' }
    $value = $field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($Directory)
    if ($value.Current.Value -ne $Directory) { throw 'The folder-name field did not accept the target path.' }
    Invoke-DialogButton '1' # IDOK
    # Some Shell versions navigate into the typed directory on the first click.
    # Retry only against the original window, while its original process is still alive.
    if (-not $picker.WaitForExit(1500)) {
        try {
            if (-not $dialog.Current.IsOffscreen -and $dialog.Current.IsEnabled) { Invoke-DialogButton '1' }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # The Shell has already destroyed the observed dialog.
        }
    }
}
if (-not $picker.WaitForExit(5000)) { throw "The native chooser PID $($picker.Id) remained open after $Action." }
Write-Output "Windows folder dialog PID $($picker.Id): completed $Action."
