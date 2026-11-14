' Скрытный запуск бота: без консольного окна, лог пишется в bot.log.
' Удобно положить ярлык в автозагрузку (Win+R -> shell:startup).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node src\index.js >> bot.log 2>&1", 0, False
