@echo off
REM raven — zero-npm Windows launcher. Runs the harness from this repo with the
REM type-stripping flag, forwarding all arguments. Put this repo folder on your
REM PATH (or copy this file to a PATH dir) and type `raven` from anywhere.
REM The .cmd host gives the cleaner interactive Ctrl+C behavior (cancels the
REM current turn rather than killing the app).
node --experimental-strip-types "%~dp0src\main.ts" %*
