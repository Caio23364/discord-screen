@echo off
echo ==================================================
echo       Compilando Fabricio Desktop App
echo ==================================================

echo.
echo [1/3] Instalando dependencias (se necessario)...
call npm install

echo.
echo [2/3] Compilando arquivos do Frontend (Vite)...
call npm run build

echo.
echo [3/3] Gerando executavel (.exe) (Electron Builder)...
call npm run dist

echo.
echo ==================================================
echo Concluido! O executavel esta na pasta dist-electron
echo ==================================================
pause
