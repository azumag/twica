#!/bin/bash

# Zellijの左隣ペーン監視スクリプト
# 左隣のペーンの出力が1分以上変化していない場合、自動的に "/pm" を送信

DUMP_FILE="/tmp/zellij_pane_dump_$$.txt"
PREV_DUMP_FILE="/tmp/zellij_pane_dump_prev_$$.txt"
LAST_CHANGE_TIME=$(date +%s)

echo "Zellij pane monitor started. Monitoring left pane for inactivity..."
echo "Press Ctrl+C to stop."

# クリーンアップ関数
cleanup() {
    echo -e "\nCleaning up..."
    rm -f "$DUMP_FILE" "$PREV_DUMP_FILE"
    exit 0
}

trap cleanup INT TERM

while true; do
    # 左隣のペーンに移動
    zellij action focus-previous-pane
    sleep 0.3

    # ペーンの内容をダンプ
    zellij action dump-screen "$DUMP_FILE" 2>/dev/null

    # 元のペーン（Claude）に戻る
    zellij action focus-next-pane
    sleep 0.3

    # 内容が変化したかチェック
    if [ -f "$PREV_DUMP_FILE" ]; then
        if ! diff -q "$DUMP_FILE" "$PREV_DUMP_FILE" > /dev/null 2>&1; then
            # 内容が変化した
            LAST_CHANGE_TIME=$(date +%s)
            echo "[$(date '+%H:%M:%S')] Activity detected in left pane. Resetting timer."
        else
            # 内容が変化していない
            CURRENT_TIME=$(date +%s)
            ELAPSED=$((CURRENT_TIME - LAST_CHANGE_TIME))

            if [ $ELAPSED -ge 60 ]; then
                echo "[$(date '+%H:%M:%S')] No activity for $ELAPSED seconds. Sending /pm command..."

                # 左隣のペーンに移動してコマンド送信
                zellij action focus-previous-pane
                sleep 0.3
                zellij action write-chars "/singlerun"
                zellij action write 32
                sleep 1.5
                zellij action write 13
                sleep 0.3
                zellij action focus-next-pane

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
