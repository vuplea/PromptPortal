// The windowed host relays raw VT from the session's pty to this console. A
// Windows console's default output mode turns a bare LF into CR+LF ("auto
// return"), but ConPTY's re-serialized stream positions text with bare LFs
// and expects the column to hold — auto return shifts such text to column 1,
// into cells the source screen never repaints, which lingers as ghost
// characters (e.g. in the two-column gutter of Claude Code's fullscreen
// renderer). DISABLE_NEWLINE_AUTO_RETURN restores standard VT line-feed
// semantics; ssh.exe sets it for the same reason.

const STD_OUTPUT_HANDLE = -11;
const DISABLE_NEWLINE_AUTO_RETURN = 0x0008;

export function disableNewlineAutoReturn(): void {
  if (process.platform !== 'win32') return;
  const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel32 = dlopen('kernel32.dll', {
    GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
    GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  }).symbols;
  const handle = kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
  if (!handle) return;
  const mode = new Uint32Array(1);
  if (!kernel32.GetConsoleMode(handle, ptr(mode))) return; // stdout is not a console
  kernel32.SetConsoleMode(handle, mode[0]! | DISABLE_NEWLINE_AUTO_RETURN);
}
