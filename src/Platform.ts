import os from "os"

const _platform = os.platform()

export const isWin = ["win32", "cygwin"].includes(_platform)
export const isMac = _platform === "darwin"
export const isLinux = _platform === "linux"
