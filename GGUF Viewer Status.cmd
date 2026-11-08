@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\gguf_viewer.ps1" status
pause
