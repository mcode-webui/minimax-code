# Fixed launcher-owned program. No request text is accepted as code or arguments.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { exit 3 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace WebuiFolderPicker {
 [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
 [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IFileDialog {
  [PreserveSig] int Show(IntPtr owner);
  void SetFileTypes(uint count, IntPtr filters);
  void SetFileTypeIndex(uint index);
  void GetFileTypeIndex(out uint index);
  void Advise(IntPtr events, out uint cookie);
  void Unadvise(uint cookie);
  void SetOptions(uint options);
  void GetOptions(out uint options);
  void SetDefaultFolder(IShellItem item);
  void SetFolder(IShellItem item);
  void GetFolder(out IShellItem item);
  void GetCurrentSelection(out IShellItem item);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetFileName(out IntPtr name);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void GetResult(out IShellItem item);
 }
 [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellItem {
  void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
  void GetParent(out IShellItem parent);
  void GetDisplayName(uint name, out IntPtr result);
  void GetAttributes(uint mask, out uint attributes);
  void Compare(IShellItem other, uint hint, out int order);
 }
 public static class Picker {
  public static string Choose() {
   object instance = new FileOpenDialog(); IShellItem item = null; IntPtr name = IntPtr.Zero;
   try {
    var dialog = (IFileDialog)instance;
    uint flags; dialog.GetOptions(out flags);
    // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST | DONTADDTORECENT.
    dialog.SetOptions(flags | 0x20u | 0x40u | 0x800u | 0x2000000u);
    int result = dialog.Show(IntPtr.Zero);
    if (result == unchecked((int)0x800704C7)) return null;
    Marshal.ThrowExceptionForHR(result);
    dialog.GetResult(out item); item.GetDisplayName(0x80058000u, out name);
    return Marshal.PtrToStringUni(name);
   } finally {
    if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
    if (item != null) Marshal.FinalReleaseComObject(item);
    Marshal.FinalReleaseComObject(instance);
   }
  }
 }
}
'@
try {
 $directory = [WebuiFolderPicker.Picker]::Choose()
 if ($null -eq $directory) { '{"kind":"cancelled"}' }
 else { @{kind='selected';directory=$directory} | ConvertTo-Json -Compress }
} catch { exit 3 }
