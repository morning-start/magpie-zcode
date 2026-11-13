// tests/support/home.mjs —— 把 homedir 指到一个一次性目录
//
// ZCode 的登录态（~/.zcode/v2/credentials.json、setting.json、config.json）和
// provider 配置都在用户家目录下。测试不能读、也不能写用户真的那一份 ——
// 上游测试开头就断言 homedir() 必须在 tmpdir 里，这里把它变成真的。
//
// ⚠ 必须在 index.mjs / src 被 import 之前执行（ESM 按 import 顺序求值，
//   所以每个测试文件把它放在第一行）。
// ⚠ Windows 上 os.homedir() 读的是 USERPROFILE，POSIX 读的是 HOME，两个都设。

import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "zcode-test-")))

process.env.HOME = home
process.env.USERPROFILE = home
// 有的运行时在 USERPROFILE 为空时拼 HOMEDRIVE + HOMEPATH，清掉免得指回真家目录
process.env.HOMEDRIVE = ""
process.env.HOMEPATH = ""

export { home }
