Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\Dell\agent-gateway"
sh.Run "node ""C:\Users\Dell\agent-gateway\src\gateway.mjs""", 0, False
