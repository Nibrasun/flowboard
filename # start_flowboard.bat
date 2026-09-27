@echo off
title FlowBoard Launcher
echo ================================
echo   Menjalankan FlowBoard
echo   (Backend + Frontend)
echo ================================
echo.

:: Jalankan backend di background (tanpa window)
start /b "" cmd /c "cd /d "D:\Application\Google Flow\flowboard\agent" && call .venv\Scripts\activate && uvicorn flowboard.main:app --reload --port 8434 --timeout-graceful-shutdown 2"

:: Tunggu sebentar
timeout /t 3 /nobreak >nul

:: Jalankan frontend di background
if exist "D:\Application\Google Flow\flowboard\frontend" (
    start /b "" cmd /c "cd /d "D:\Application\Google Flow\flowboard\frontend" && npm run dev"
) else (
    start /b "" cmd /c "cd /d "D:\Application\Google Flow\flowboard" && npm run dev"
)

:: Tutup jendela launcher
exit
:: Tidak ada pause, jendela akan langsung tertutup setelah perintah selesai