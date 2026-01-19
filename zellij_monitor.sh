#!/bin/bash

# Zellijの現在ペーン監視スクリプト
# 現在のペーンの出力が1分以上変化していない場合、自動的に "/singlerun" を送信

# Zellijがまだ起動していない場合は起動
if [ -z "$ZELLIJ" ]; then
    echo "Starting Zellij session..."
    SCRIPT_PATH="$(realpath "$0")"

    # バックグラウンドでzellijセッションを作成
    zellij attach -b -c monitor
    sleep 1

    # セッションにopencode用のペーンを追加
    zellij -s monitor action new-pane --direction right
    sleep 0.5
    zellij -s monitor action write-chars "opencode"
    zellij -s monitor action write 13
    sleep 0.5

    # 元のペーンに戻ってスクリプトを実行
    zellij -s monitor action focus-previous-pane
    sleep 0.3
    zellij -s monitor action write-chars "$SCRIPT_PATH"
    zellij -s monitor action write 13

    # セッションにアタッチ
    exec zellij attach monitor
fi

DUMP_FILE="/tmp/zellij_pane_dump_$$.txt"
PREV_DUMP_FILE="/tmp/zellij_pane_dump_prev_$$.txt"
LAST_CHANGE_TIME=$(date +%s)

echo "Zellij pane monitor started. Monitoring current pane for inactivity..."
echo "Press Ctrl+C to stop."

# クリーンアップ関数
cleanup() {
    echo -e "\nCleaning up..."
    rm -f "$DUMP_FILE" "$PREV_DUMP_FILE"
    exit 0
}

trap cleanup INT TERM

while true; do
    # 現在のペーンの内容をダンプ（ペーン移動なし）
    zellij action dump-screen "$DUMP_FILE" 2>/dev/null

    # 内容が変化したかチェック
    if [ -f "$PREV_DUMP_FILE" ]; then
        if ! diff -q "$DUMP_FILE" "$PREV_DUMP_FILE" > /dev/null 2>&1; then
            # 内容が変化した
            LAST_CHANGE_TIME=$(date +%s)
            echo "[$(date '+%H:%M:%S')] Activity detected in current pane. Resetting timer."
        else
            # 内容が変化していない
            CURRENT_TIME=$(date +%s)
            ELAPSED=$((CURRENT_TIME - LAST_CHANGE_TIME))

            if [ $ELAPSED -ge 60 ]; then
                echo "[$(date '+%H:%M:%S')] No activity for $ELAPSED seconds. Sending /singlerun command..."

                # 現在のペーンにコマンド送信（ペーン移動なし）
                zellij action write-chars "/singlerun"
                zellij action write 32
                sleep 1.5
                zellij action write 13

                # タイマーをリセット
                LAST_CHANGE_TIME=$(date +%s)
                echo "[$(date '+%H:%M:%S')] Command sent. Timer reset."
            else
                echo -ne "[$(date '+%H:%M:%S')] No activity for ${ELAPSED}s (waiting for 60s)...\r"
            fi
        fi
    fi

    # 現在のダンプを保存
    cp "$DUMP_FILE" "$PREV_DUMP_FILE" 2>/dev/null

    # 5秒待つ（チェック頻度）
    sleep 5
done
