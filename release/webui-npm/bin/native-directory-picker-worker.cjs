'use strict';

// The dialog child: the WebUI server must not block inside the Win32 modal
// call, and a child spawned by a background server has no foreground rights.
// This process owns the IFileOpenDialog through koffi, presses Alt once before
// Show so the dialog activates, and reports the selection over IPC.

if (typeof process.send !== 'function') process.exit(1);
const send = process.send.bind(process);
function post(message, final) {
  if (!process.connected) return;
  send(message, () => { if (final && process.connected) process.disconnect(); });
}
process.on('disconnect', () => process.exit(0));

let koffi;
try {
  koffi = require('koffi');
} catch (error) {
  post({ kind: 'error', message: String(error && error.message || error) }, true);
  setTimeout(() => process.exit(1), 10);
}

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const SIGDN_FILESYSPATH = 0x80058000 | 0;
const HRESULT_CANCELLED = 0x800704c7 | 0;
const FOS_PICKFOLDERS = 0x20;
const FOS_FORCEFILESYSTEM = 0x40;
const FOS_NOCHANGEDIR = 0x8;
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2];
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x2;
const SLOT_RELEASE = 2;
const SLOT_SHOW = 3;
const SLOT_SET_OPTIONS = 9;
const SLOT_SET_TITLE = 17;
const SLOT_GET_RESULT = 20;
const SLOT_GET_DISPLAY_NAME = 5;
const TITLE = process.env.MCODE_DIALOG_TITLE || '选择文件夹';

function guidBytes(text) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text);
  if (!match) throw new Error('invalid GUID');
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(match[1], 16), 0);
  bytes.writeUInt16LE(parseInt(match[2], 16), 4);
  bytes.writeUInt16LE(parseInt(match[3], 16), 6);
  Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8);
  return bytes;
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7');
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960');

function readUtf16(address, pointerSize) {
  const pointer = Buffer.alloc(8);
  pointer.writeBigUInt64LE(BigInt(address));
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16');
}

function check(hr, what) {
  if (hr < 0) throw new Error(what + ' failed: HRESULT 0x' + (hr >>> 0).toString(16));
  return hr;
}

function runFolderDialog(onShowing) {
  const ole32 = koffi.load('ole32.dll');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const pointerSize = koffi.sizeof('void *');
  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', []);
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *']);
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *']);
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']);

  const protoShow = koffi.proto('int32 __stdcall McodeDialogShow(void *self, void *owner)');
  const protoSetOptions = koffi.proto('int32 __stdcall McodeDialogSetOptions(void *self, uint32 options)');
  const protoSetTitle = koffi.proto('int32 __stdcall McodeDialogSetTitle(void *self, str16 title)');
  const protoGetResult = koffi.proto('int32 __stdcall McodeDialogGetResult(void *self, _Out_ void **item)');
  const protoGetDisplayName = koffi.proto('int32 __stdcall McodeItemGetDisplayName(void *self, int32 form, _Out_ void **name)');
  const protoRelease = koffi.proto('uint32 __stdcall McodeComRelease(void *self)');

  function method(self, slot, proto) {
    const vtable = koffi.decode(self, 'void *');
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *');
    return (...args) => koffi.call(fn, proto, self, ...args);
  }

  function setThreadDpiAwareness() {
    let setContext;
    try {
      setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr']);
    } catch {
      return;
    }
    for (const context of DPI_AWARENESS_CONTEXTS) {
      try { if (setContext(context) !== null) return; } catch { return; }
    }
  }

  function pressAltForForeground() {
    keybdEvent(VK_MENU, 0, 0, 0);
    keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  }

  setThreadDpiAwareness();
  check(coInitializeEx(null, COINIT_APARTMENTTHREADED), 'CoInitializeEx');
  try {
    const out = Buffer.alloc(pointerSize);
    check(coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out), 'CoCreateInstance');
    const dialog = koffi.decode(out, 'void *');
    try {
      check(method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR), 'SetOptions');
      check(method(dialog, SLOT_SET_TITLE, protoSetTitle)(TITLE), 'SetTitle');
      onShowing(getCurrentThreadId());
      pressAltForForeground();
      const shown = method(dialog, SLOT_SHOW, protoShow)(null);
      if (shown === HRESULT_CANCELLED) return null;
      check(shown, 'Show');
      const itemOut = [null];
      check(method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut), 'GetResult');
      const item = itemOut[0];
      try {
        const nameOut = [null];
        check(method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut), 'GetDisplayName');
        const selected = readUtf16(nameOut[0], pointerSize);
        coTaskMemFree(nameOut[0]);
        return selected;
      } finally {
        method(item, SLOT_RELEASE, protoRelease)();
      }
    } finally {
      method(dialog, SLOT_RELEASE, protoRelease)();
    }
  } finally {
    coUninitialize();
  }
}

if (koffi) {
  try {
    const selected = runFolderDialog((threadId) => post({ kind: 'showing', threadId }, false));
    post({ kind: 'done', path: selected }, true);
  } catch (error) {
    post({ kind: 'error', message: String(error && error.message || error) }, true);
  }
}