import { platform } from "os"

export const isWin = ["win32", "cygwin"].includes(platform())
