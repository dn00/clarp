@echo off
REM Mirrors how Claude Code installs on Windows: a .cmd shim that invokes node.
REM node-pty/ConPTY runs this through cmd.exe, so the real node process below is
REM a grandchild with a pid that differs from node-pty's reported pid.
node "%~dp0child.mjs"
