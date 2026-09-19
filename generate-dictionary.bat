@echo off
chcp 65001 >nul
echo [german-dictionary] 开始构建德语离线字典索引...
echo.

cd /d "%~dp0"
npm run build:german-dictionary -- --url "https://kaikki.org/dictionary/German/index.html" --allow-under-target

echo.
if %ERRORLEVEL% EQU 0 (
    echo [german-dictionary] 构建成功！
    echo  输出目录: public\data\german\
    echo  包含文件: index-core.json (高频 ~5000 条)
    echo            index.json    (完整 ~50000 条)
    echo.
    echo 请确保 public\data\german\ 目录下的文件已提交到 Git 仓库。
) else (
    echo [german-dictionary] 构建失败，请检查上方日志。
    pause
)
