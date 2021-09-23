import os from "os"

export const isWin = ["win32", "cygwin"].includes(os.platform())
